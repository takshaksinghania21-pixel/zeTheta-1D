// Copies runtime assets (config + templates) next to the compiled output so
// path.resolve(__dirname, '../../config') works identically in src/ and dist/src/.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
cpSync('config', 'dist/config', { recursive: true });
cpSync('templates', 'dist/templates', { recursive: true });
console.log('copied config/ and templates/ into dist/');
