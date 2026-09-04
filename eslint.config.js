// IO BILL — vérification statique ciblée
// ═══════════════════════════════════════════════════════════════════
// Ce projet n'avait aucun linter, et `vite build` ne remplace pas cette
// vérification : Vite compile le JSX sans se demander si un identifiant
// existe. Une facture émise, un menu, une page entière peuvent donc partir
// en production avec une référence morte, invisible au build et fatale au
// premier rendu.
//
// C'est arrivé : la v8.53 a supprimé une déclaration `const` en laissant ses
// quatre usages. Le build est passé, /invoices est resté noir en production.
//
// La règle no-undef aurait arrêté ce commit. C'est la seule qu'on active en
// erreur : elle n'a pratiquement pas de faux positifs et couvre exactement
// cette classe de panne. Le reste est en avertissement, pour informer sans
// bloquer — un linter qui crie sur du code qui marche finit ignoré.
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["src/**/*.{js,jsx}", "api/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // La panne qu'on cherche à empêcher.
      "no-undef": "error",
      // Un hook appelé après un `return` anticipé casse React à l'exécution,
      // et le build n'en dit rien non plus. Cette règle fait le contrôle que
      // je faisais à la main en relisant chaque composant modifié.
      "react-hooks/rules-of-hooks": "error",
      // Déjà neutralisée par des commentaires `eslint-disable` à plusieurs
      // endroits, avec de bonnes raisons documentées : on l'informe seulement.
      "react-hooks/exhaustive-deps": "warn",
      // Symptôme fréquent d'une suppression incomplète : une variable qu'on
      // a cessé d'utiliser sans la retirer. Informatif, pas bloquant.
      "no-unused-vars": ["warn", {
        args: "none",
        varsIgnorePattern: "^(_|React$)",
        caughtErrors: "none"
      }]
    }
  },
  {
    // Les tests Playwright tournent sous Node avec leurs propres globales.
    files: ["tests/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-undef": "error" }
  },
  { ignores: ["dist/**", "node_modules/**", "public/**"] }
];
