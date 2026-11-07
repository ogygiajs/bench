import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseSync } from 'oxc-parser';
import { private_bindings } from './transform/instrument.ts';

/*
 * Types for private functions (spec 7). The bench transform appends
 * `export const __abax = { <private top-level bindings> }` to every module; this writes a sidecar
 * d.ts that tells TypeScript about it, so a bench file can write
 *
 *   import { __abax } from '../src/router/match.ts';
 *   __abax.normalize(path)      // fully typed, even though normalize is not exported
 *
 * How: the TS checker sees each module with the same `__abax` export appended and emits its
 * declaration file. Everything that file declares without exporting (the private functions and the
 * local types they mention) moves into a namespace inside a module augmentation, and `__abax` is
 * typed through that namespace.
 */

type TS = typeof import('typescript');

const NS = '__abax_private';

function load_ts(): TS {
	return createRequire(import.meta.url)('typescript') as TS;
}

function rel_specifier(from_dir: string, to_file: string): string {
	let r = relative(from_dir, to_file).split(sep).join('/');
	if (!r.startsWith('.')) r = './' + r;
	return r;
}

export interface DtsOptions {
	files: string[];
	out: string;
	tsconfig?: string;
}

function appended_source(file: string, text: string): string {
	const parsed = parseSync(file, text, { sourceType: 'module' });
	const bindings = private_bindings(
		parsed.program as unknown as Parameters<typeof private_bindings>[0]
	);
	const props = bindings.map((b) => (b.live ? `get ${b.name}() { return ${b.name}; }` : b.name));
	return `${text}\nexport const __abax = { ${props.join(', ')} };\n`;
}

export function private_dts(opts: DtsOptions): string {
	const ts = load_ts();
	const files = opts.files.map((f) => resolve(f));
	const targets = new Set(files);
	let options: import('typescript').CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		strict: true,
		skipLibCheck: true
	};
	if (opts.tsconfig) {
		const cfg = ts.readConfigFile(opts.tsconfig, ts.sys.readFile);
		const parsed = ts.parseJsonConfigFileContent(
			cfg.config,
			ts.sys,
			dirname(resolve(opts.tsconfig))
		);
		options = { ...parsed.options };
	}
	options = {
		...options,
		declaration: true,
		emitDeclarationOnly: true,
		noEmit: false,
		declarationMap: false
	};

	const host = ts.createCompilerHost(options);
	const get_source = host.getSourceFile.bind(host);
	host.getSourceFile = (name, lang, onError, create) => {
		const abs = resolve(name);
		if (targets.has(abs)) {
			return ts.createSourceFile(name, appended_source(abs, readFileSync(abs, 'utf8')), lang, true);
		}
		return get_source(name, lang, onError, create);
	};
	const program = ts.createProgram(files, options, host);
	const out_dir = dirname(resolve(opts.out));
	const printer = ts.createPrinter({ removeComments: true });
	const imports = new Set<string>();
	const blocks: string[] = [];

	for (const file of files) {
		const sf = program.getSourceFile(file);
		if (!sf) continue;
		let dts = '';
		program.emit(
			sf,
			(_name, text) => {
				dts = text;
			},
			undefined,
			true
		);
		const d = ts.createSourceFile('x.d.ts', dts, ts.ScriptTarget.ESNext, true);
		const locals: string[] = [];
		const local_names = new Set<string>();
		let abax_type: import('typescript').TypeNode | null = null;

		for (const st of d.statements) {
			if (ts.isImportDeclaration(st)) {
				const spec = (st.moduleSpecifier as import('typescript').StringLiteral).text;
				let text = st.getText(d);
				if (spec.startsWith('.')) {
					const target = rel_specifier(out_dir, resolve(dirname(file), spec));
					text = text
						.split(JSON.stringify(spec))
						.join(JSON.stringify(target))
						.split(`'${spec}'`)
						.join(`'${target}'`);
				}
				imports.add(text);
				continue;
			}
			const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
			const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
			if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
			if (exported) {
				if (ts.isVariableStatement(st)) {
					for (const decl of st.declarationList.declarations) {
						if (ts.isIdentifier(decl.name) && decl.name.text === '__abax' && decl.type)
							abax_type = decl.type;
					}
				}
				continue;
			}
			const named = st as import('typescript').Statement & {
				name?: import('typescript').Identifier;
			};
			if (ts.isVariableStatement(st)) {
				for (const decl of st.declarationList.declarations) {
					if (ts.isIdentifier(decl.name)) local_names.add(decl.name.text);
				}
			} else if (named.name && ts.isIdentifier(named.name)) {
				local_names.add(named.name.text);
			}
			let text = st.getText(d);
			if (text.startsWith('declare ')) text = text.slice(8);
			locals.push('export ' + tabs(text));
		}
		if (!abax_type) continue;

		const qualify = <T extends import('typescript').Node>(node: T): T => {
			const visit = (n: import('typescript').Node): import('typescript').Node => {
				if (
					ts.isTypeQueryNode(n) &&
					ts.isIdentifier(n.exprName) &&
					local_names.has(n.exprName.text)
				) {
					return ts.factory.createTypeQueryNode(
						ts.factory.createQualifiedName(ts.factory.createIdentifier(NS), n.exprName.text)
					);
				}
				if (
					ts.isTypeReferenceNode(n) &&
					ts.isIdentifier(n.typeName) &&
					local_names.has(n.typeName.text)
				) {
					return ts.factory.createTypeReferenceNode(
						ts.factory.createQualifiedName(ts.factory.createIdentifier(NS), n.typeName.text),
						n.typeArguments
							? n.typeArguments.map((a) => ts.visitNode(a, visit) as import('typescript').TypeNode)
							: undefined
					);
				}
				return ts.visitEachChild(n, visit, undefined);
			};
			return ts.visitNode(node, visit) as T;
		};
		const type_text = tabs(printer.printNode(ts.EmitHint.Unspecified, qualify(abax_type), d));
		const spec = rel_specifier(out_dir, file);
		const body = [
			`declare module '${spec.split('\\').join('\\\\').split("'").join("\\'")}' {`,
			`\tnamespace ${NS} {`,
			...locals.map((l) =>
				l
					.split('\n')
					.map((x) => '\t\t' + x)
					.join('\n')
			),
			'\t}',
			`\texport const __abax: ${type_text.split('\n').join('\n\t')};`,
			'}'
		];
		blocks.push(body.join('\n'));
	}

	return [
		'// Generated by abax: types of the `__abax` export (private bindings) of each module.',
		...imports,
		'export {};',
		'',
		...blocks,
		''
	].join('\n');
}

/** TypeScript prints with four spaces; the file around it indents with tabs. */
function tabs(text: string): string {
	return text
		.split('\n')
		.map((line) => {
			let n = 0;
			while (line.startsWith('    ', n * 4)) n++;
			return '\t'.repeat(n) + line.slice(n * 4);
		})
		.join('\n');
}

export function write_private_dts(opts: DtsOptions): void {
	writeFileSync(opts.out, private_dts(opts));
}
