// SPDX-License-Identifier: AGPL-3.0-only
import * as renderer from './index';
import * as runtime from './runtime';
import * as clock from './clock';
import * as edits from './edits';
import * as math from './math';
import * as shapes from './shapes';
import * as paths from './paths';
import * as transitions from './transitions';
import * as compiler from './compiler';
import * as cache from './cache';
(window as any).mg = { ...renderer, ...runtime, ...clock, ...edits, ...math, ...shapes, ...paths, ...transitions, ...compiler, ...cache };
