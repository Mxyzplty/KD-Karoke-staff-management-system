// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { compileMotionGraphic } from '../apps/web/src/mg/compiler';

describe('motion graphic compiler', () => {
  it('strips imports and accepts a component using config sizing', () => {
    const result = compileMotionGraphic(`import React from 'react';
const helper = () => 42;
export const Graphic = () => { const {width, height} = useVideoConfig(); return <div style={{width, height}}>{helper()}</div>; };`);
    expect(result.name).toBe('Graphic');
    expect(result.js).not.toMatch(/import\s+React/);
  });

  it.each(['img', 'video', 'audio'])('rejects native <%s> elements', tag => {
    expect(() => compileMotionGraphic(`export const Graphic = () => <${tag} />;`)).toThrow(new RegExp(`Native <${tag}>`));
  });

  it('does not mistake media words in text for native elements', () => {
    expect(() => compileMotionGraphic(`export const Graphic = () => <div>{'video image audio'}</div>;`)).not.toThrow();
  });

  it('accepts a component without export, as observed in G-13', () => {
    expect(() => compileMotionGraphic('const Graphic = () => <div />;')).not.toThrow();
  });

  it('rejects default exports, helper statements after the component, and invalid syntax', () => {
    expect(() => compileMotionGraphic('export default function Graphic() { return <div />; }')).toThrow();
    expect(() => compileMotionGraphic('export const Graphic = () => <div />; const helper = 1;')).toThrow();
    expect(() => compileMotionGraphic('export const Graphic = () => <div;')).toThrow();
  });

  it('never executes user code in the editor realm while compiling', () => {
    const marker = '__t08aHostExecutionProbe';
    delete (globalThis as Record<string, unknown>)[marker];
    const code = `globalThis.${marker} = true; export const Graphic = () => <div />;`;
    try { compileMotionGraphic(code); } catch { /* static rejection is also safe */ }
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});
