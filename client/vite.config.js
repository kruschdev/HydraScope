import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function stampAssetContentHashes() {
    return {
        name: 'hydrascope-asset-version-stamp',
        closeBundle() {
            const distDir = path.resolve(import.meta.dirname, 'dist');
            const htmlPath = path.join(distDir, 'index.html');
            const jsPath = path.join(distDir, 'assets', 'app.js');
            const cssPath = path.join(distDir, 'assets', 'app.css');
            if (!fs.existsSync(htmlPath)) return;

            let html = fs.readFileSync(htmlPath, 'utf8');
            if (fs.existsSync(jsPath)) {
                const jsHash = crypto.createHash('sha256').update(fs.readFileSync(jsPath)).digest('hex').slice(0, 10);
                html = html.replace('/assets/app.js', `/assets/app.js?v=${jsHash}`);
            }
            if (fs.existsSync(cssPath)) {
                const cssHash = crypto.createHash('sha256').update(fs.readFileSync(cssPath)).digest('hex').slice(0, 10);
                html = html.replace('/assets/app.css', `/assets/app.css?v=${cssHash}`);
            }
            fs.writeFileSync(htmlPath, html, 'utf8');
        }
    };
}

export default defineConfig({
    plugins: [react(), stampAssetContentHashes()],
    build: {
        target: 'es2022',
        rollupOptions: {
            output: {
                inlineDynamicImports: true,
                entryFileNames: 'assets/app.js',
                assetFileNames: 'assets/app.[ext]'
            }
        }
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:4190',
            '/health': 'http://127.0.0.1:4190',
            '/doctor': 'http://127.0.0.1:4190'
        }
    }
});
