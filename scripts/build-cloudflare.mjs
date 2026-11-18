import { mkdir,copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/public',{recursive:true});
const files={
  'website.html':'index.html','index.html':'workspace.html','phone.html':'phone.html',
  'website.css':'website.css','style.css':'style.css','pcm.js':'pcm.js',
  'node_modules/katex/dist/katex.min.js':'katex.js',
  'node_modules/mammoth/mammoth.browser.min.js':'cv-docx.js',
  'node_modules/pdfjs-dist/build/pdf.min.mjs':'cv-pdf.mjs',
  'node_modules/pdfjs-dist/build/pdf.worker.min.mjs':'cv-worker.mjs'
};
for(const [source,destination] of Object.entries(files))await copyFile(source,'dist/public/'+destination);
await build({entryPoints:['app.ts','website.ts'],outdir:'dist/public',bundle:false,format:'esm',target:'es2022',logLevel:'warning'});
console.log('Cloudflare static assets built in dist/public.');
