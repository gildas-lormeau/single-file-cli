import js from "@eslint/js";

export default [
	{ ignores: ["lib/single-file-archive.js", "lib/single-file-filename.js", "lib-dev/**", ".dev/**"] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2025,
			sourceType: "module",
			globals: {
				console: "readonly",
			}
		},
		rules: {
			"indent": [
				"error",
				"tab",
				{
					"SwitchCase": 1
				}
			],
			"linebreak-style": [
				"error",
				"unix"
			],
			"quotes": [
				"error",
				"double"
			],
			"semi": [
				"error",
				"always"
			],
			"no-console": [
				"warn"
			],
			"no-empty": [
				"error",
				{
					"allowEmptyCatch": true
				}
			]
		}
	}
];
