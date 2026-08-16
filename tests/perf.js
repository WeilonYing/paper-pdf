const { chromium } = require('playwright');
const fs=require('fs'), path=require('path'), http=require('http');
const ROOT = path.join(__dirname, '..');
const LAUNCH = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
  : {};
// serve fixtures too, so the browser fetches them instead of receiving
// six million JSON array elements through page.evaluate
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.pdf':'application/pdf'};
http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
const f = p.startsWith('/fx/') ? path.join(__dirname, 'fixtures', p.slice(4)) : path.join(ROOT,p); if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end();return;}
res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);}).listen(8816);
(async()=>{
  const b=await chromium.launch(LAUNCH);
  const pg=await b.newPage({viewport:{width:1440,height:900}});
  pg.on('pageerror',e=>console.log('PAGEERROR',e.message));
  await pg.goto('http://localhost:8816/index.html');
  await pg.waitForFunction(()=>window.Paper);

  for (const f of ['big.pdf','scanned.pdf']) {
    const t0=Date.now();
    await pg.evaluate(async(n)=>{
      const r = await fetch('/fx/'+n);
      const u = new Uint8Array(await r.arrayBuffer());
      await window.Paper.open(u,n);
    }, f);
    await pg.waitForFunction(()=>window.Paper.ready());
    const openMs=Date.now()-t0;
    const info = await pg.evaluate(()=>({
      pages: window.Paper.pageCount(),
      analysed: window.Paper.state.analyses.size,
      blocks: window.Paper.blocks(0).length,
      hidden: window.Paper.hiddenBlocks(0).length,
      status: document.getElementById('status').textContent,
      toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent
    }));
    console.log(f, 'open', openMs+'ms', JSON.stringify(info));

    if (info.blocks) {
      const id = (await pg.evaluate(()=>window.Paper.blocks(0)))[0].id;
      await pg.evaluate((i)=>window.Paper.setText(i,'Edited on a large document'), id);
      const t1=Date.now();
      const r = await pg.evaluate(()=>window.Paper.build());
      console.log('   build', (Date.now()-t1)+'ms', 'bytes', r.bytes.length, JSON.stringify(r.report));
    }
  }
  await b.close(); process.exit(0);
})();
