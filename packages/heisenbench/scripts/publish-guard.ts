/*
 * `prepublishOnly`: stop a plain `npm publish` in packages/heisenbench. npm would publish this
 * package.json as it is: the bin and exports pointing at src/*.ts and `catalog:` versions. pnpm
 * applies publishConfig and turns `catalog:` into real versions when it packs, so publish with
 * `pnpm publish`, or `pnpm pack` and then `npm publish heisenbench-<version>.tgz`.
 */
const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('pnpm/')) {
	console.error(
		'heisenbench: publish with pnpm (`pnpm publish`), or `pnpm pack` and then `npm publish <the .tgz>`. A plain `npm publish` here would ship the source layout and catalog: versions.'
	);
	process.exit(1);
}
