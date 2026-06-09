require("ts-node").register({
  project: "./tsconfig.json",
});
require("./src/worker.ts");
