const nextJest = require("next/jest");
const createJestConfig = nextJest({ dir: "./" });

module.exports = createJestConfig({
  testEnvironment: "node",
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  // тестами считаем только *.test.ts — вспомогательные фейки в __tests__/helpers не запускаются
  testMatch: ["**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
});
