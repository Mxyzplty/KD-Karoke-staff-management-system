// SPDX-License-Identifier: AGPL-3.0-only
// Choices where the sources disagree (T08 notes, Author-only questions Q4–Q7 and D25): the add / edit summary error code,
// and the rendering choices where Xapp's export differs from public Remotion (reference compares §1.3). Each question is one
// switch here; the defaults are the chosen answers.
export const PARITY = {
  /** Q4. The code for a summary that is given but empty or over 400 characters, on add and edit: 'MISSING_PARAM' as error
   *  codes §9, or 'VALIDATION_ERROR' as agent tool results §2. A missing summary on an edit is MISSING_PARAM either way. */
  summaryCode: 'MISSING_PARAM' as 'MISSING_PARAM' | 'VALIDATION_ERROR',
  /** Q5 (§1.3 item 12). 'remotion': a Sequence is hidden from `from + durationInFrames` on. 'xapp-export': it is still
   *  drawn on that end frame (its child sees frame durationInFrames). */
  sequenceEnd: 'remotion' as 'remotion' | 'xapp-export',
  /** Q6 (§1.3 item 11). 'passed': a transition's exit style is applied only where that transition passes one. Xapp's export
   *  also draws another transition's exit style on some exiting scenes; its rule is unknown, so there is no second value. */
  exitStyle: 'passed' as const,
  /** Q7 (§1.3 item 9, D29). 'honour': OffthreadVideo `endAt` ends the clip as `trimAfter` does, at the SOURCE frame `endAt`
   *  (nothing drawn from graphic frame (endAt - startFrom) / playbackRate on), as current Remotion. 'undivided': the cut is
   *  at graphic frame (endAt - startFrom), because Remotion 4.0.427, which Xapp's export runs, does not divide `endAt` by
   *  `playbackRate`; in reference part 07 that lands at f150, past the clip's last frame f149, so the video plays on.
   *  Xapp's export does not ignore `endAt`, so there is no value for that. `trimAfter` is a source frame either way. */
  endAt: 'honour' as 'honour' | 'undivided',
  /** D25 (§1.3 item 6). 'drawn': a Sequence's `style` is drawn, as in public Remotion. 'none': not drawn, as in Xapp. */
  sequenceStyle: 'drawn' as 'drawn' | 'none',
};
