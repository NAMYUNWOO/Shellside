// Monaco for apps: the `CodeEditor` of the `board` module (runtime.tsx) loads this the first time an app shows one.
// server/apps.ts bundles it together with Monaco's own list of editor features (editor.main.js), less the language
// services (TypeScript, CSS, HTML and JSON checking): they run in web workers, and an app's sandbox has none. What
// stays: the whole editor, and syntax colors for ~80 languages.
import * as monaco from "monaco-editor/editor/editor.api.js";

// JSON colors: Monaco's JSON comes with its worker service only, so it is left out above.
monaco.languages.register({ id: "json", extensions: [".json", ".jsonc", ".json5"], aliases: ["JSON", "json"], mimetypes: ["application/json"] });
monaco.languages.setLanguageConfiguration("json", {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
});
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/\/\/.*$/, "comment"],
      [/[{}[\],:]/, "delimiter"],
    ],
  },
});

(globalThis as { __wbMonaco?: typeof monaco }).__wbMonaco = monaco;
