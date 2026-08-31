const fs = require('fs');
const html = fs.readFileSync('admin.html', 'utf8');
const selRe = /<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
let m;
while ((m = selRe.exec(html))) {
  const opts = [...m[2].matchAll(/<option[^>]*value="([^"]*)"/g)].map(o => o[1]);
  console.log(m[1] + ' -> ' + opts.join(' | ').slice(0, 220));
}
