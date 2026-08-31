const fs = require('fs'), path = require('path'), os = require('os');
const dir = path.join(os.tmpdir(), 'bh-syntax');
fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync('supabase/functions', path.join(dir, 'functions'), { recursive: true });
fs.writeFileSync(path.join(dir, 'stub.ts'), 'export const createClient=()=>({}); export default {};\n');
const stubPath = path.join(dir, 'stub.ts').replace(/\\/g, '/');
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!p.endsWith('.ts')) continue;
    let t = fs.readFileSync(p, 'utf8');
    t = t.replace(/from\s+['"](?:npm:|https?:|jsr:)[^'"]*['"]/g, 'from "' + stubPath + '"');
    fs.writeFileSync(p, t);
  }
}
walk(path.join(dir, 'functions'));
console.log('prepped');
