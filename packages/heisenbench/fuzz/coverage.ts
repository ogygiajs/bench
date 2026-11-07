/**
 * The AST node types the counting transform handles on its own (a `case` of its walk, or a member
 * or wrapper it treats specially): the generator's coverage is measured against these. Node types
 * a module cannot hold (`with`) or that never reach the walk are left out.
 */
export const HANDLED = [
	// statements
	'BlockStatement',
	'BreakStatement',
	'ClassDeclaration',
	'ContinueStatement',
	'DoWhileStatement',
	'EmptyStatement',
	'ExportDefaultDeclaration',
	'ExportNamedDeclaration',
	'ExpressionStatement',
	'ForInStatement',
	'ForOfStatement',
	'ForStatement',
	'FunctionDeclaration',
	'IfStatement',
	'LabeledStatement',
	'ReturnStatement',
	'SwitchStatement',
	'SwitchCase',
	'ThrowStatement',
	'TryStatement',
	'CatchClause',
	'VariableDeclaration',
	'WhileStatement',
	// expressions
	'ArrayExpression',
	'ArrowFunctionExpression',
	'AssignmentExpression',
	'AwaitExpression',
	'BinaryExpression',
	'CallExpression',
	'ChainExpression',
	'ClassExpression',
	'ConditionalExpression',
	'FunctionExpression',
	'Identifier',
	'Literal',
	'LogicalExpression',
	'MemberExpression',
	'MetaProperty',
	'NewExpression',
	'ObjectExpression',
	'PrivateIdentifier',
	'SequenceExpression',
	'SpreadElement',
	'Super',
	'TaggedTemplateExpression',
	'TemplateLiteral',
	'ThisExpression',
	'UnaryExpression',
	'UpdateExpression',
	'YieldExpression',
	// patterns
	'ArrayPattern',
	'AssignmentPattern',
	'ObjectPattern',
	'RestElement',
	// class and object members
	'MethodDefinition',
	'PropertyDefinition',
	'StaticBlock',
	'Property',
	// TS expression wrappers
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression'
];

export interface CoverageSummary {
	covered: string[];
	missing: string[];
	share: number;
}

export function coverage_of(seen: Iterable<string>): CoverageSummary {
	const s = new Set(seen);
	const covered = HANDLED.filter((t) => s.has(t));
	const missing = HANDLED.filter((t) => !s.has(t));
	return { covered, missing, share: Math.round((covered.length / HANDLED.length) * 1000) / 10 };
}
