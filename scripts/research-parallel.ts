import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
const browser=new CipaBrowser(loadConfig());const p=browser as any;
try {
 await browser.warmup(AbortSignal.timeout(30000));
 const session=await p.acquire();let page=session.page;
 const result=await p.searchOn(session,{q:'BW00000790718',page:1,pageSize:20});
 await page.getByRole('link',{name:`${result.items[0].name} (BW00000790718)`,exact:true}).click();
 await page.getByRole('heading',{name:'General Details',exact:true}).waitFor();await p.settle(session);
 const root1=await page.evaluate(()=>(window as any).serviceVue.viewtree.root);
 const start=performance.now();const other=await session.context.newPage();
 await other.goto(page.url(),{waitUntil:'domcontentloaded'});
 await other.getByRole('heading',{name:'General Details',exact:true}).waitFor();
 const root2=await other.evaluate(()=>(window as any).serviceVue.viewtree.root);
 console.log({independentRoot:root1!==root2,newPageMs:Math.round(performance.now()-start),sameUrl:page.url()===other.url()});
 const s2={context:session.context,page:other,state:{}};
 await Promise.all([p.remoteClick(session,page.getByRole('tab',{name:'Directors',exact:true})),p.remoteClick(s2,other.getByRole('tab',{name:'Addresses',exact:true}))]);
 console.log({first:await page.getByRole('tabpanel',{name:'Directors',exact:true}).isVisible(),second:await other.getByRole('tabpanel',{name:'Addresses',exact:true}).isVisible()});
 await p.remoteClick(session,page.getByRole('tab',{name:'Secretaries',exact:true}));
 console.log({originalStillValid:await page.getByRole('tabpanel',{name:'Secretaries',exact:true}).isVisible()});
}finally{await browser.close();}
