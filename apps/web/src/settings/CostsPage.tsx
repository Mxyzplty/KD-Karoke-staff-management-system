// SPDX-License-Identifier: AGPL-3.0-only
// T21 Costs (contract #5): every optional paid extra the app can use, who bills it, and the two real limits of this device.
import { useEffect, useState } from 'react';
import { reportError } from '../ui';
import { formatBytes } from './local';
import { ELEVENLABS, PRESETS } from './providers';

const HOSTED = PRESETS.filter(p => p.billedBy);
const CODECS: { label: string; codec: string }[] = [{ label: 'H.264', codec: 'avc1.42E01E' }, { label: 'HEVC', codec: 'hvc1.1.6.L93.B0' }, { label: 'VP9', codec: 'vp09.00.10.08' }, { label: 'AV1', codec: 'av01.0.04M.08' }];
type Decode = 'hardware' | 'software' | 'none';
async function decodeSupport(codec: string): Promise<Decode> {
  if (!('VideoDecoder' in globalThis)) return 'none';
  const check = async (hardwareAcceleration: HardwareAcceleration) => (await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration }).catch(() => ({ supported: false }))).supported;
  return await check('prefer-hardware') ? 'hardware' : await check('prefer-software') ? 'software' : 'none';
}
const DECODE_TEXT: Record<Decode, string> = { hardware: 'Hardware', software: 'Software only', none: 'Not supported' };
const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;
/** Each provider's own figures on STOCK_CHECKED; none of them is in our control. */
const STOCK_CHECKED = '5 Nov 2026';
const STOCK: { label: string; limits: string; beyond: string; links: [string, string][] }[] = [
  { label: 'Pexels', limits: '200 requests per hour and 20,000 requests per month.', beyond: 'Pexels lifts the limits free of charge if you credit it. New API keys are paused.', links: [['https://www.pexels.com/api/documentation/', 'Pricing and limits']] },
  { label: 'Unsplash', limits: '50 requests per hour as a demo app, 1,000 requests per hour once Unsplash approves it for production.', beyond: 'No price is published. Unsplash asks you to get in touch for more.', links: [['https://unsplash.com/developers', 'Pricing and limits']] },
  { label: 'Freesound', limits: '60 requests per minute and 2,000 requests per day. Some calls, such as downloading the original file, are limited to 30 requests per minute and 500 requests per day.', beyond: 'Free for non-commercial use only. No price is published: Freesound asks commercial users to get in touch.', links: [['https://freesound.org/docs/api/overview.html', 'Limits'], ['https://freesound.org/docs/api/terms_of_use.html', 'Terms']] },
];
export function CostsPage() {
  const [quota, setQuota] = useState<StorageEstimate>(), [decode, setDecode] = useState<Record<string, Decode>>();
  useEffect(() => {
    void navigator.storage.estimate().then(setQuota).catch(reportError);
    void Promise.all(CODECS.map(async c => [c.label, await decodeSupport(c.codec)] as const)).then(rows => setDecode(Object.fromEntries(rows))).catch(reportError);
  }, []);
  return <div className="costs"><h1>Costs</h1>
    <p>Cutframe has no subscription, watermark or paid core limits. Available local space depends on this browser and device.</p>
    <h2>Optional paid extras</h2><p>You need none of these. Each one is off until you add it in Settings, and the provider bills you directly. Cutframe adds no fee.</p>
    <table data-testid="costs-extras"><thead><tr><th>Extra</th><th>Used for</th><th>Billed by</th><th>Pricing</th></tr></thead><tbody>
      {HOSTED.map(p => <tr key={p.label}><td>{p.label}</td><td>Built-in chat, motion-graphic repair, generated titles</td><td>{p.billedBy}</td><td>{link(p.pricing!, 'Pricing')}</td></tr>)}
      <tr><td>ElevenLabs</td><td>Hosted speech to text</td><td>ElevenLabs</td><td>{link(ELEVENLABS.pricing, 'Pricing')}</td></tr>
      <tr><td>Your backup folder’s sync service</td><td>An off-device copy of your media</td><td>That service</td><td>Your own plan</td></tr>
    </tbody></table>
    <h2>Free alternatives</h2><ul>
      <li>Local model servers (Ollama, LM Studio, llama.cpp, vLLM): no provider bills them. You pay for your own hardware and power.</li>
      <li>Speech to text on this device: free.</li>
      <li>Stock media from Pexels, Unsplash and Freesound: free API keys within the limits below. Freesound is free only for non-commercial use.</li>
      <li>Your own agent through the helper: your agent’s plan, not Cutframe, covers its usage.</li>
    </ul>
    <h2>Stock media limits</h2><p data-testid="costs-stock-date">Each provider sets its own limits. Checked {STOCK_CHECKED} on their own pages; they may change.</p>
    <table data-testid="costs-stock"><thead><tr><th>Provider</th><th>Limits</th><th>Beyond the limits</th><th>Links</th></tr></thead><tbody>
      {STOCK.map(s => <tr key={s.label}><td>{s.label}</td><td>{s.limits}</td><td>{s.beyond}</td><td>{s.links.map(([href, text], n) => <span key={href}>{n > 0 && ' · '}{link(href, text)}</span>)}</td></tr>)}
    </tbody></table>
    <h2>This device</h2>
    <dl className="usage">
      <dt>Browser storage quota</dt><dd data-testid="costs-quota">{quota ? `${formatBytes(quota.usage ?? 0)} used of ${formatBytes(quota.quota ?? 0)}` : 'Checking…'}</dd>
      {CODECS.map(c => <div key={c.label} style={{ display: 'contents' }}><dt>{c.label} decoding</dt><dd data-codec={c.label}>{decode ? DECODE_TEXT[decode[c.label]] : 'Checking…'}</dd></div>)}
    </dl>
  </div>;
}
