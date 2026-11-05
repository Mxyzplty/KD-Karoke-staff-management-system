// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let listener: Server, url: string, requests = 0, connections = 0;
test.beforeAll(async () => {
  listener = createServer((_req, res) => { requests++; res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Connection', 'close'); res.end('local test listener'); });
  listener.on('connection', () => { connections++; });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/sandbox-navigation`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => listener.close(e => e ? reject(e) : resolve())); });
test.beforeEach(async ({ page }) => {
  requests = connections = 0; await page.goto('/src/mg/harness.html');
  await page.evaluate(async url => { await (await fetch(url)).text(); }, url);
  expect(requests).toBe(1); expect(connections).toBe(1);
  requests = connections = 0;
});

async function expectNoEgress() {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect({ requests, connections }).toEqual({ requests: 0, connections: 0 });
}

async function execute(page: Page, code: string, render = true) {
  return page.evaluate(async ({ code, render }) => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer();
    try { if (render) await renderer.render({ code, frame: 0, width: 32, height: 32 }); else await renderer.compile(code); return { code: 'ok', message: '' }; }
    catch (e) { return { code: (e as any).code, message: (e as Error).message }; }
    finally { renderer.dispose(); }
  }, { code, render });
}

for (const tag of ['a', 'area', 'form', 'meta']) {
  for (const factory of ['jsx', 'createElement', 'forged']) {
    test(`${tag} navigation is blocked through ${factory}`, async ({ page }) => {
      const props = tag === 'meta' ? `{httpEquiv:'refresh',content:${JSON.stringify('0;url=')}+${JSON.stringify('URL')}}` : `{href:'URL',action:'URL',ref:e=>{if(e)e.${tag === 'form' ? 'submit' : 'click'}();}}`;
      const type = JSON.stringify(tag), value = JSON.stringify(url);
      const p = props.replaceAll("'URL'", value).replaceAll('"URL"', value);
      const element = factory === 'jsx' ? `<${tag} {...${p}}/>` : factory === 'createElement' ? `React.createElement(${type},${p})` : `({$$typeof:Symbol.for('react.transitional.element'),type:${type},key:null,props:${p}})`;
      const result = await execute(page, `export const Graphic=()=>${element};`);
      expect(['VALIDATION_ERROR', 'MG_SANDBOX_DENIED']).toContain(result.code);
      await expectNoEgress();
    });
  }
}

for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
  test(`meta navigation through ${sink} is blocked`, async ({ page }) => {
    const markup = JSON.stringify(`<meta http-equiv="refresh" content="0;url=${url}">`);
    const write = sink === 'insertAdjacentHTML' ? `e.insertAdjacentHTML('beforeend',${markup})` : `e.${sink}=${markup}`;
    const result = await execute(page, `export const Graphic=()=> <div ref={e=>{if(e){${write};}}}/>;`);
    expect(result.code).toBe('MG_SANDBOX_DENIED'); await expectNoEgress();
  });
}

test('frame, document and changing-key navigation routes are blocked', async ({ page }) => {
  const operations = [
    `frames[0].location=${JSON.stringify(url)}`,
    `e.ownerDocument.location=${JSON.stringify(url)}`,
    `e['owner'+'Document']['default'+'View']['loc'+'ation']=${JSON.stringify(url)}`,
    `let n=0;const key={toString:()=>++n===1?'title':'location'};e.getRootNode()[key]=${JSON.stringify(url)}`,
    `let n=0;const key={toString:()=>++n===1?'location':'title'};e.getRootNode()[key]=${JSON.stringify(url)}`,
  ];
  const expected = ['VALIDATION_ERROR','VALIDATION_ERROR','MG_SANDBOX_DENIED','ok','MG_SANDBOX_DENIED'];
  for (const [i, operation] of operations.entries()) {
    const result = await execute(page, `export const Graphic=()=> <div ref={e=>{if(e){${operation};}}}/>;`);
    expect(result.code).toBe(expected[i]);
    await expectNoEgress();
  }
});

test('guarded code and denied constructors keep the host heartbeat below 300 ms', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = '/src/mg/index.ts'; const { createMotionGraphicRenderer } = await import(/* @vite-ignore */ path);
    const renderer = createMotionGraphicRenderer(); let last = performance.now(), maxGap = 0, ticks = 0;
    const heartbeat = setInterval(() => { const now=performance.now(); maxGap=Math.max(maxGap,now-last); last=now; ticks++; },5);
    const codes = [];
    for (const code of [
      'export const Graphic=()=>{while(true){} return <div/>;};',
      "export const Graphic=()=>{const k='con'+'structor'; return <div>{(()=>{})[k]}</div>;};",
      "export const Graphic=()=> <ThreeCanvas width={32} height={32} onCreated={()=>{}}/>;",
    ]) { try { await renderer.compile(code); codes.push('ok'); } catch(e) { codes.push((e as any).code); } }
    await new Promise(resolve=>setTimeout(resolve,10)); maxGap=Math.max(maxGap,performance.now()-last);
    clearInterval(heartbeat); renderer.dispose(); return { maxGap, ticks, codes };
  });
  expect(result.codes).toEqual(['MG_WATCHDOG','MG_SANDBOX_DENIED','UNSUPPORTED_OPTION']);
  expect(result.ticks).toBeGreaterThan(0); expect(result.maxGap).toBeLessThan(300);
  test.info().annotations.push({ type: 'heartbeat-max-gap-ms', description: String(result.maxGap) });
});

for (const method of ['assign','replace','href']) {
  test(`navigation through a document value using ${method} is blocked by the container`, async ({ page }) => {
    const navigate = method === 'href' ? `target.href=${JSON.stringify(url)}` : `target.${method}(${JSON.stringify(url)})`;
    const result=await execute(page, `export const Graphic=()=> <div ref={element=>{if(element){const target=Object.values(element.getRootNode()).find(value=>String(value)==='about:srcdoc');if(!target)throw Error('Location value unavailable');${navigate};}}}/>;`);
    expect(result.code).toBe('MG_SANDBOX_DENIED'); await expectNoEgress();
  });
}

for (const [name, body] of [
  ['cumulative arrays', 'const held=[];for(let i=0;i<50;i++)held.push(Array(1000000).fill(i));'],
  ['cumulative buffers', 'const held=[];for(let i=0;i<300;i++)held.push(new ArrayBuffer(1000000));'],
  ['string padding', "const held='a'.padEnd(2**28,'a');"],
  ['array-call spread', 'const held=[...Array(30000000).keys()];'],
]) {
  test(`${name} exceeds the memory budget and is refused`, async ({ page }) => {
    const result = await execute(page, `export const Graphic=()=>{${body}return <div/>;};`, false);
    expect(result.code).toBe('MG_MEMORY_LIMIT');
  });
}

test('forged error codes are not trusted and createElement media matches JSX', async ({ page }) => {
  expect(await execute(page, "export const Graphic=()=>{throw {code:'MG_MEMORY_LIMIT',message:'authored ordinary error'};};", false)).toEqual({code:'COMPILATION_ERROR',message:'compilation error: authored ordinary error'});
  const jsx = await execute(page, 'export const Graphic=()=> <video/>;', false);
  const factory = await execute(page, "export const Graphic=()=> React.createElement('video');", false);
  expect(factory).toEqual(jsx); expect(factory.code).toBe('VALIDATION_ERROR');
});

test('a thousand styled elements rasterise in less than 1.5 seconds', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path='/src/mg/index.ts';const {renderMotionGraphic}=await import(/* @vite-ignore */ path);
    const start=performance.now();
    const frame=await renderMotionGraphic({code:"export const Graphic=()=> <div>{Array.from({length:1000},(_,i)=><span key={i} style={{display:'inline-block',width:1,height:1,backgroundColor:'lime'}}/>)}</div>;",frame:0,width:64,height:64});
    return { elapsed:performance.now()-start, count:frame.boxes.length, image:frame.image.slice(0,22) };
  });
  expect(result.count).toBe(1001); expect(result.image).toBe('data:image/png;base64,'); expect(result.elapsed).toBeLessThan(1500);
  test.info().annotations.push({ type: 'rasterise-ms', description: String(result.elapsed) });
});

test('the container blocks an inner self-navigation, reports it and removes the child', async ({ page }) => {
  const result = await page.evaluate(async url => {
    const path='/src/mg/index.ts';const {containerDocument}=await import(/* @vite-ignore */ path);
    const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');
    const reported=new Promise<boolean>(resolve=>{
      const timer=setTimeout(()=>{removeEventListener('message',receive);resolve(false);},1000);
      const receive=(event:MessageEvent)=>{if(event.source===frame.contentWindow && event.data?.type==='mg:navigated'){clearTimeout(timer);removeEventListener('message',receive);resolve(true);}};
      addEventListener('message',receive);
    });
    frame.srcdoc=containerDocument(`setTimeout(()=>{location.href=${JSON.stringify(url)};},20);`,32,32);document.body.append(frame);
    return await reported;
  }, url);
  expect(result).toBe(true); await expectNoEgress();
  await expect.poll(()=>page.frames().length).toBe(2);
});

for (const target of ['parent','top']) {
  test(`the container sandbox refuses navigation of ${target}`, async ({ page }) => {
    const result = await page.evaluate(async ({ url, target }) => {
      const path='/src/mg/index.ts';const {containerDocument}=await import(/* @vite-ignore */ path);
      const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');
      try {
        return await new Promise<string>((resolve,reject)=>{
          const timer=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Missing container refusal'));},1000);
          const receive=(event:MessageEvent)=>{if(event.source===frame.contentWindow?.[0] && event.data?.type==='container-refusal'){clearTimeout(timer);removeEventListener('message',receive);resolve(event.data.name);}};
          addEventListener('message',receive);
          frame.srcdoc=containerDocument(`try{${target}.location.href=${JSON.stringify(url)};}catch(error){parent.parent.postMessage({type:'container-refusal',name:error.name},'*');}`,32,32);
          document.body.append(frame);
        });
      } finally { frame.remove(); }
    }, { url, target });
    expect(result).toBe('SecurityError'); await expectNoEgress();
  });
}

test('native async, generator, async-generator and realtime constructors are denied in the frame', async ({ page }) => {
  const result=await page.evaluate(async () => {
    const path='/src/mg/index.ts', bundle='/src/mg/sandbox.generated.js?raw';
    const {containerDocument}=await import(/* @vite-ignore */ path);const {default:source}=await import(/* @vite-ignore */ bundle);
    const frame=document.createElement('iframe');frame.id='bootstrap-test';frame.sandbox.add('allow-scripts');
    const result=new Promise<string[]>(resolve=>{
      const receive=(event:MessageEvent)=>{if(event.source===frame.contentWindow?.[0] && event.data?.type==='constructor-check'){removeEventListener('message',receive);resolve(event.data.results);}};
      addEventListener('message',receive);
    });
    // The test script runs after bootstrap without Playwright's eval, which the runtime deliberately disables.
    frame.srcdoc=containerDocument(source+`;const results=[];
      for(const fn of [function(){},async function(){},function*(){},async function*(){}]){
        try{Object.getPrototypeOf(fn).constructor('return 1');results.push('allowed');}catch(e){results.push(e.code);}
      }
      for(const name of ['RTCPeerConnection','webkitRTCPeerConnection']){
        try{new globalThis[name]();results.push('allowed');}catch(e){results.push(e.code);}
      }
      parent.parent.postMessage({type:'constructor-check',results},'*');`,32,32);
    document.body.append(frame);return await result;
  });
  expect(result).toEqual(Array(6).fill('MG_SANDBOX_DENIED'));
});

test('ambient capabilities and navigation API are unreachable from generated code', async ({ page }) => {
  for (const name of ['Reflect','frames','parent','top','navigation','RTCPeerConnection','webkitRTCPeerConnection']) {
    const result=await execute(page, `export const Graphic=()=>{${name}();return <div/>;};`,false);
    expect(['VALIDATION_ERROR','MG_SANDBOX_DENIED']).toContain(result.code);
  }
});

test('Sequence frame ids, premount clamps and postmount clamps match the pinned cases', async ({ page }) => {
  const result=await page.evaluate(async()=>{
    const path='/src/mg/index.ts';const {createMotionGraphicRenderer}=await import(/* @vite-ignore */ path);
    const renderer=createMotionGraphicRenderer();const ids=[];
    const inner="const Inner=()=> <div id={'f'+useCurrentFrame()}/>;";
    for(const [frame,wrapper] of [
      [60,'<Sequence from={30}><Inner/></Sequence>'],
      [60,'<Sequence from={-30}><Inner/></Sequence>'],
      [60,'<Sequence from={20}><Sequence from={20}><Inner/></Sequence></Sequence>'],
      [60,'<Sequence from={45} durationInFrames={45}><Inner/></Sequence>'],
      [3,'<Sequence from={5} durationInFrames={4} premountFor={3}><Inner/></Sequence>'],
      [10,'<Sequence from={5} durationInFrames={4} postmountFor={2}><Inner/></Sequence>'],
      [4,'<Sequence from={5} premountFor={0.9}><Inner/></Sequence>'],
      [5,'<Sequence from={5} premountFor={-2}><Inner/></Sequence>'],
    ] as const) {const frameImage=await renderer.render({code:inner+`export const Graphic=()=>${wrapper};`,frame,width:32,height:32});ids.push(frameImage.boxes.map((b:any)=>b.id).filter(Boolean));}
    renderer.dispose();return ids;
  });
  expect(result).toEqual([['f30'],['f90'],['f20'],['f15'],['f0'],['f3'],[],['f0']]);
});
