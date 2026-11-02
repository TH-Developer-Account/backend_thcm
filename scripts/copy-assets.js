const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const DIST_DIR = path.join(__dirname, "..", "dist");
const ASSET_EXTENSIONS = [".hbs"];

function isAssetFile(filePath) {
  return ASSET_EXTENSIONS.includes(path.extname(filePath));
}

fs.cpSync(SRC_DIR, DIST_DIR, {
  recursive: true,
  force: true,
  filter: (source) => {
    if (fs.statSync(source).isDirectory()) {
      return true;
    }
    return isAssetFile(source);
  },
});

console.log("Copied non-TypeScript runtime assets to dist/");
