const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'node_modules', 'monaco-editor', 'min');
const destDir = path.join(__dirname, '..', 'dist', 'monaco');

if (!fs.existsSync(srcDir)) {
    console.error('[copy-monaco] monaco-editor/min not found. Run npm install first.');
    process.exit(1);
}

function copyRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Clean old copy
if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
}

// Copy only the minified AMD build (loader + vs/)
copyRecursive(srcDir, destDir);

// Rename loader.js at root if present
const loaderSrc = path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs', 'loader.js');
const loaderDest = path.join(destDir, 'loader.js');
if (fs.existsSync(loaderSrc) && !fs.existsSync(loaderDest)) {
    fs.copyFileSync(loaderSrc, loaderDest);
}

const count = fs.readdirSync(destDir, { recursive: true }).length;
console.log(`[copy-monaco] copied ${count} files to ${destDir}`);
