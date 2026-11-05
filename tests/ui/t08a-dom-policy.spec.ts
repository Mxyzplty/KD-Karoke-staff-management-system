// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { UNSAFE_TAGS } from '../../apps/web/src/mg/policy';

// Test-authored detached fixtures exercise DOM policy directly, without navigating or loading resources.
async function bootstrapCheck(page: Page, before: string, check: string) {
  return page.evaluate(async ({ before, check }) => {
    const path = '/src/mg/index.ts', bundle = '/src/mg/sandbox.generated.js?raw';
    const { containerDocument } = await import(/* @vite-ignore */ path);
    const { default: source } = await import(/* @vite-ignore */ bundle);
    const frame = document.createElement('iframe'); frame.sandbox.add('allow-scripts');
    try {
      return await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { removeEventListener('message', receive); reject(Error('DOM policy check timed out')); }, 5000);
        const receive = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow?.[0] || event.data?.type !== 'dom-policy-check') return;
          clearTimeout(timer); removeEventListener('message', receive); resolve(event.data.result);
        };
        addEventListener('message', receive);
        frame.srcdoc = containerDocument(before + '\n' + source + '\n' + check, 32, 32);
        document.body.append(frame);
      });
    } finally { frame.remove(); }
  }, { before, check });
}

test.beforeEach(async ({ page }) => { await page.goto('/src/mg/harness.html'); });

for (const factory of ['createElement', 'createElementNS', 'createDocument', 'createHTMLDocument', 'cloneNode', 'importNode', 'cloneContents', 'extractContents']) {
  test(`${factory} refuses every unsafe element with the sandbox code`, async ({ page }) => {
    const results = await bootstrapCheck(page, `const fixtureAppend=Node.prototype.appendChild;const fixtures=${JSON.stringify(UNSAFE_TAGS)}.map(name=>document.createElement(name));`, `
      const results=fixtures.map(element=>{
        try {
          const name=element.localName;
          switch(${JSON.stringify(factory)}) {
            case 'createElement': document.createElement(name); break;
            case 'createElementNS': document.createElementNS('urn:authored-policy-test','test:'+name); break;
            case 'createDocument': document.implementation.createDocument('urn:authored-policy-test','test:'+name); break;
            case 'createHTMLDocument': document.implementation.createHTMLDocument(name); break;
            case 'cloneNode': element.cloneNode(true); break;
            case 'importNode': document.importNode(element,true); break;
            default: {
              const holder=document.createElement('div');
              // Fixtures remain detached; native insertion was captured before policy installation.
              fixtureAppend.call(holder,element);
              const range=document.createRange();range.selectNodeContents(holder);
              range[${JSON.stringify(factory)}]();
            }
          }
          return 'allowed';
        } catch(error) { return error.code; }
      });
      parent.parent.postMessage({type:'dom-policy-check',result:results},'*');
    `);
    expect(results).toEqual(UNSAFE_TAGS.map(() => 'MG_SANDBOX_DENIED'));
  });
}

test('every insertion API checks unsafe descendants before changing the tree', async ({ page }) => {
  const cases = ['appendChild','insertBefore','replaceChild','append','prepend','before','after','replaceWith','insertAdjacentElement','replaceChildren'].flatMap(method => UNSAFE_TAGS.map(tag => ({ method, tag })));
  const result = await bootstrapCheck(page, `
    const fixtureAppend=Node.prototype.appendChild;
    const fixtures=${JSON.stringify(cases)}.map(({tag})=>{
      const fragment=document.createDocumentFragment(),wrapper=document.createElement('div');
      wrapper.append(document.createElement(tag));fragment.append(wrapper);return fragment;
    });`, `
    const results=${JSON.stringify(cases)}.map(({method},i)=>{
      const holder=document.createElement('div'),marker=document.createElement('span');holder.append(marker);
      const node=fixtures[i];
      try {
        switch(method) {
          case 'appendChild': holder.appendChild(node);break;
          case 'insertBefore': holder.insertBefore(node,marker);break;
          case 'replaceChild': holder.replaceChild(node,marker);break;
          case 'before': marker.before(node);break;
          case 'after': marker.after(node);break;
          case 'replaceWith': marker.replaceWith(node);break;
          case 'insertAdjacentElement': holder.insertAdjacentElement('beforeend',node.firstChild);break;
          default: holder[method](node);
        }
        return 'allowed';
      } catch(error) { return {code:error.code,unchanged:holder.childNodes.length===1&&holder.firstChild===marker}; }
    });
    parent.parent.postMessage({type:'dom-policy-check',result:results},'*');`);
  expect(result).toEqual(cases.map(() => ({ code: 'MG_SANDBOX_DENIED', unchanged: true })));
});

test('a normal rendered sandbox has zero child browsing contexts', async ({ page }) => {
  const result = await bootstrapCheck(page, '', `
    const channel=new MessageChannel();
    channel.port1.onmessage=event=>{
      if(event.data.type) return; // mg:hold and mg:out are notices on this port, not the result (the host skips them too)
      if(event.data.ok!==true) parent.parent.postMessage({type:'dom-policy-check',result:event.data},'*');
      else parent.parent.postMessage({type:'dom-policy-check',result:{ok:true,frames:length}},'*');
    };
    dispatchEvent(new MessageEvent('message',{source:parent.parent,data:{type:'mg:init',mode:'render',js:'return function Graphic(){return React.createElement("div",null,"normal");}',options:{frame:0,width:32,height:32}},ports:[channel.port2]}));`);
  expect(result).toEqual({ ok: true, frames: 0 });
});

test('invocation intrinsics cannot change a genuine render or error code', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    const mutation = `const proto=Object.getPrototypeOf(()=>{});let refused=0;for(const key of ['call','apply','bind']){try{Object.defineProperty(proto,key,{value:()=>{throw Error('altered intrinsic');}});}catch{refused++;}}if(refused!==3)throw Error('intrinsic remained mutable');`;
    try {
      const frame = await renderer.render({ code: `export const Graphic=()=>{${mutation}return <div id='genuine-result'/>;};`, frame: 0, width: 32, height: 32 });
      let code = '';
      try { await renderer.compile(`export const Graphic=()=>{${mutation}throw Error('genuine failure');};`); }
      catch (error) { code = (error as any).code; }
      return { ids: frame.boxes.map((box: any) => box.id), code };
    } finally { renderer.dispose(); }
  });
  expect(result).toEqual({ ids: ['genuine-result'], code: 'COMPILATION_ERROR' });
});

for (const outcome of ['success','error']) {
  test(`an own sender invocation property preserves genuine ${outcome}`, async ({ page }) => {
    const result = await page.evaluate(async outcome => {
      const path='/src/mg/index.ts';const {createMotionGraphicRenderer}=await import(/* @vite-ignore */ path);
      const renderer=createMotionGraphicRenderer();
      const code=`export const Graphic=()=> <div id="genuine-sender-result" ref={element=>{
        if(!element)return;
        const event=element.getRootNode().createEvent('Event');event.initEvent('authored-sender-check',true,false);
        element.addEventListener('authored-sender-check',event=>{
          const sandbox=event.composedPath().at(-1),channel=new sandbox.MessageChannel(),sender=channel.port1.postMessage;
          Object.defineProperty(sender,'call',{configurable:true,value:(receiver,value)=>sender.apply(receiver,[{ok:false,code:'MG_MEMORY_LIMIT',message:'authored shadow result'}])});
          if(!Object.hasOwn(sender,'call'))throw Error('Own invocation property was not installed');
          channel.port1.close();channel.port2.close();
        });
        element.dispatchEvent(event);
        ${outcome === 'error' ? "throw Error('genuine rendered failure');" : ''}
      }}/>;`;
      try {
        const frame=await renderer.render({code,frame:0,width:32,height:32});
        return {ok:true,ids:frame.boxes.map((box:any)=>box.id)};
      } catch(error) { return {ok:false,code:(error as any).code,message:(error as Error).message}; }
      finally { renderer.dispose(); }
    }, outcome);
    expect(result).toEqual(outcome==='success'?{ok:true,ids:['genuine-sender-result']}:{ok:false,code:'MG_RENDER_FAILED',message:'genuine rendered failure'});
  });
}

for (const terminal of ['success','error','watchdog','dispose']) {
  test(`renderer leaves no iframes after ${terminal}`, async ({ page }) => {
    const result = await page.evaluate(async terminal => {
      const path='/src/mg/index.ts';const {createMotionGraphicRenderer}=await import(/* @vite-ignore */ path);
      const renderer=createMotionGraphicRenderer();
      const code=terminal==='error'?"export const Graphic=()=>{throw Error('cleanup');};":terminal==='watchdog'?'export const Graphic=()=>{while(true){}return <div/>;};':'export const Graphic=()=> <div/>;';
      const pending=renderer.render({code,frame:0,width:32,height:32}).then(()=> 'ok',(error: {code:string})=>error.code);
      if(terminal==='dispose') {
        while(!document.querySelector('iframe')) await new Promise(resolve=>setTimeout(resolve,0));
        renderer.dispose();
      }
      const codeResult=await pending;renderer.dispose();return codeResult;
    }, terminal);
    expect(result).toBe(({success:'ok',error:'COMPILATION_ERROR',watchdog:'MG_WATCHDOG',dispose:'MG_DISPOSED'} as Record<string,string>)[terminal]);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect.poll(()=>page.frames().length).toBe(1);
  });
}
