// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

// Each snippet is executed by the actual sandbox and must produce measured DOM
// elements as well as a decodable frame. Existence of injected names alone is
// intentionally not treated as rendering acceptance.
const snippets = [
  ['React and hooks', `export const Graphic = () => { const [n] = useState(2); const ref = useRef(3); const v = useMemo(() => n + ref.current, [n]); const cb = useCallback(() => v, [v]); useEffect(() => {}, []); return React.createElement('div', null, cb()); };`],
  ['frame, config, easing and interpolation', `export const Graphic = () => { const f = useCurrentFrame(), c = useVideoConfig(); const v = interpolate(f, [0, 20], [0, 100], { easing: Easing.inOut(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'wrap' }); return <AbsoluteFill style={{backgroundColor: interpolateColors(v, [0,100], ['red','blue'])}}><div>{c.width} {c.height} {c.fps} {c.durationInFrames}</div></AbsoluteFill>; };`],
  ['spring and Sequence', `const Inner = () => <div>{useCurrentFrame()} {spring({frame:useCurrentFrame(),fps:30,config:{mass:1,damping:10,stiffness:100,overshootClamping:true},from:0,to:10,durationInFrames:30,delay:1,reverse:true})}</div>; export const Graphic = () => <Sequence from={-2} durationInFrames={20} layout="none"><Inner /></Sequence>;`],
  ['shape components', `export const Graphic = () => <AbsoluteFill><Rect width={8} height={8} fill="red" /><Circle radius={4} fill="blue" /><Ellipse rx={4} ry={2} /><Triangle length={8} direction="up" /><Star innerRadius={2} outerRadius={4} points={5} /><Polygon radius={4} points={5} /><Heart height={8} /><Pie radius={4} progress={0.5} /></AbsoluteFill>;`],
  ['shape makers', `export const Graphic = () => { const paths = [makeRect({width:10,height:10,cornerRadius:2}),makeCircle({radius:5}),makeEllipse({rx:5,ry:3}),makeTriangle({length:10,direction:'left'}),makeStar({points:5,innerRadius:2,outerRadius:5}),makePolygon({points:5,radius:5}),makeHeart({height:10}),makePie({radius:5,progress:0.5})]; return <svg width={64} height={64}>{paths.map((p,i)=><path key={i} d={p.path} fill="red" />)}</svg>; };`],
  ['paths and noise', `export const Graphic = () => { const a='M 0 0 L 10 0', b='M 0 0 L 20 0'; const style=evolvePath(0.5,a); return <svg width={64} height={64}><path d={interpolatePath(0.5,a,b)} stroke="red" strokeDasharray={style.strokeDasharray} strokeDashoffset={style.strokeDashoffset} /><text x="0" y="20">{noise3D('test',1,2,3)}</text></svg>; };`],
  ['linear fade transition', `export const Graphic = () => <TransitionSeries><TransitionSeries.Sequence durationInFrames={20}><div>one</div></TransitionSeries.Sequence><TransitionSeries.Transition timing={linearTiming({durationInFrames:10})} presentation={fade({shouldFadeOutExitingScene:true})} /><TransitionSeries.Sequence durationInFrames={20}><div>two</div></TransitionSeries.Sequence></TransitionSeries>;`],
  ['spring slide transition', `export const Graphic = () => <TransitionSeries><TransitionSeries.Sequence durationInFrames={20}><div>one</div></TransitionSeries.Sequence><TransitionSeries.Transition timing={springTiming({durationInFrames:10,config:{damping:10}})} presentation={slide({direction:'from-right'})} /><TransitionSeries.Sequence durationInFrames={20}><div>two</div></TransitionSeries.Sequence></TransitionSeries>;`],
  ['wipe transition', `export const Graphic = () => <TransitionSeries><TransitionSeries.Sequence durationInFrames={20}><div>one</div></TransitionSeries.Sequence><TransitionSeries.Transition timing={linearTiming({durationInFrames:10})} presentation={wipe({direction:'from-top-left'})} /><TransitionSeries.Sequence durationInFrames={20}><div>two</div></TransitionSeries.Sequence></TransitionSeries>;`],
  ['editable and canvas dimensions', `export const Graphic = () => <AbsoluteFill><div>{editable('title','default')} {itemWidth} {itemHeight}</div></AbsoluteFill>;`],
] as const;

for (const [name, code] of snippets) {
  test(`sandbox renders ${name}`, async ({ page }) => {
    await page.goto('/src/mg/harness.html');
    const result = await page.evaluate(async code => {
      const path = '/src/mg/index.ts';
      const { renderMotionGraphic } = await import(/* @vite-ignore */ path);
      const frame = await renderMotionGraphic({ code, frame: 15, width: 64, height: 64, fps: 30, durationInFrames: 30, fieldValues: { title: 'edited' } });
      const image = new Image(); image.src = frame.image; await image.decode();
      return { width: image.width, height: image.height, boxes: frame.boxes.length };
    }, code);
    expect([result.width, result.height]).toEqual([64, 64]);
    expect(result.boxes).toBeGreaterThan(0);
  });
}
