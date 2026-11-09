// SPDX-License-Identifier: AGPL-3.0-only
// T21 onboarding state (§28), in localStorage so the /onboarding redirect is synchronous. The answers stay in this browser
// and steer nothing. Labels, order and the one-answer questions: compares and facts §4.3 (corrects §28's "multi-choice").
export const ONBOARDING_KEY = 'cutframe:onboarding:v1';
export type Phase = 'about-you' | 'drive-picker' | 'first-edit' | 'install' | 'connect' | 'ready';
export type Drive = 'built-in' | 'own' | 'skip';
export type Question = { id: string; title: string; multiple: boolean; options: string[] };
export type Onboarding = { phase: Phase; step: number; answers: Record<string, string[]>; other: Record<string, string>; drive?: Drive; client?: string; completed: boolean; dismissed?: boolean; skipped?: boolean };
export const OTHER = 'Other';
export const QUESTIONS: Question[] = [
  { id: 'role', title: 'Who are you?', multiple: false, options: ['Content creator / YouTuber', 'Social media manager', 'Marketing team / agency', 'Freelance video editor', 'Business owner', 'Hobbyist', 'Student', OTHER] },
  { id: 'kind', title: 'What do you make?', multiple: true, options: ['Short-form social', 'YouTube / long-form', 'Tutorials', 'Course content', 'Podcast clips', 'Product demos', 'Ads', 'Vlogs', 'Music videos', 'Cinematic', 'Sports highlights', OTHER] },
  { id: 'jobs', title: 'What should the AI do?', multiple: true, options: ['Cut dead space', 'Add captions', 'Color grade', 'Find b-roll', 'Generate thumbnails', 'Motion graphics', 'Repurpose long → short', 'Pull to the beat', 'Stabilize footage', OTHER] },
  { id: 'tools', title: 'What do you edit with today?', multiple: false, options: ['Adobe Premiere Pro', 'Final Cut Pro', 'DaVinci Resolve', 'CapCut', 'iMovie', 'Descript', 'New to editing', OTHER] },
];
const fresh = (): Onboarding => ({ phase: 'about-you', step: 0, answers: {}, other: {}, completed: false });
export function readOnboarding(): Onboarding {
  try { return { ...fresh(), ...JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? '{}') as Partial<Onboarding> }; } catch { return fresh(); }
}
export function saveOnboarding(state: Onboarding) { try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(state)); } catch { /* not stored: setup may show again */ } }
export const resetOnboarding = () => saveOnboarding(fresh());
export const finishOnboarding = () => saveOnboarding({ ...readOnboarding(), phase: 'ready', completed: true });
/** One-answer questions replace the choice; several-answer questions toggle it. */
export function choose(question: Question, chosen: string[], option: string) {
  if (!question.multiple) return [option];
  return chosen.includes(option) ? chosen.filter(o => o !== option) : [...chosen, option];
}
