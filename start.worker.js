require("ts-node").register({
  project: "./tsconfig.json",
});
require("tsconfig-paths").register();
require("./src/worker.ts");
