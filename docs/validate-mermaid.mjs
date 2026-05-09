// Lightweight Mermaid syntax validator
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const md = fs.readFileSync(new URL('./architecture-flowchart.md', import.meta.url), 'utf8');
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1]);

console.log(`Found ${blocks.length} Mermaid diagrams`);

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false });

let pass = 0, fail = 0;
for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i].trim();
    const firstLine = code.split('\n')[0];
    try {
        await mermaid.parse(code);
        console.log(`  [${i + 1}] ✅ ${firstLine}  (${code.split('\n').length} lines)`);
        pass++;
    } catch (err) {
        console.log(`  [${i + 1}] ❌ ${firstLine}`);
        console.log(`        ERROR: ${err.message?.substring(0, 200)}`);
        fail++;
    }
}

console.log(`\n${pass}/${blocks.length} diagrams valid.`);
process.exit(fail ? 1 : 0);
