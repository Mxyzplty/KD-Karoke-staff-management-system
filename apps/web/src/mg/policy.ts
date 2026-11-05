// SPDX-License-Identifier: AGPL-3.0-only
// Element and property policy shared by the host compiler and the sandbox runtime. Keep this module free of Babel.
// Xapp's agent-path texts (reference compares §1.4), audio wording included as Xapp has it. Used by every refusal path.
export const MEDIA_REFUSALS = {
  video: `compilation error: Native <video> elements are not supported. Use Remotion's <OffthreadVideo> with getAssetUrl() instead. Example: const url = getAssetUrl("video_1"); <OffthreadVideo src={url} />`,
  img: `compilation error: Native <img> elements are not supported. Use Remotion's <Img> with getAssetUrl() instead. Example: const url = getAssetUrl("image_1"); <Img src={url} />`,
  audio: `compilation error: Native <audio> elements are not supported. Use Remotion's a Remotion component with getAssetUrl() instead. Example: const url = getAssetUrl("image_1"); <Img src={url} />`,
};
// Elements that navigate, submit, load documents or run scripts. The compiler/React reject these tags;
// DOM name factories and subtree insertion/clone/import guards reject them in every namespace. HTML document creation and parsing sinks are denied.
export const UNSAFE_TAGS: readonly string[] = ['a', 'area', 'form', 'meta', 'base', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'script', 'portal', 'fencedframe'];
// Property names that lead from graphic code to documents, windows, frames, intrinsics or evaluators.
export const SENSITIVE_KEYS: readonly string[] = ['constructor', '__proto__', 'prototype', 'location', 'defaultView', 'ownerDocument', 'contentWindow', 'contentDocument', 'view', 'frames', 'opener', 'navigation', 'Reflect', 'Function', 'eval', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', '__lookupGetter__', '__lookupSetter__', '__r3f'];
// Host elements the guarded React accepts: static HTML, static SVG and react-three-fiber intrinsics.
const HTML_TAGS = 'div span p h1 h2 h3 h4 h5 h6 section article header footer main aside nav figure figcaption blockquote pre code ul ol li dl dt dd strong em b i u s small sub sup mark del ins abbr cite q kbd samp var time data br hr wbr table caption colgroup col thead tbody tfoot tr td th label button input textarea select option optgroup fieldset legend progress meter output details summary address bdi bdo ruby rt rp canvas style';
const SVG_TAGS = 'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop pattern clipPath mask marker filter image foreignObject title desc switch feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence';
const THREE_TAGS = 'mesh group scene points line lineSegments lineLoop sprite instancedMesh skinnedMesh bone lOD object3D primitive color fog fogExp2 texture canvasTexture dataTexture bufferAttribute instancedBufferAttribute float32BufferAttribute uint16BufferAttribute uint32BufferAttribute';
export const ALLOWED_TAGS: ReadonlySet<string> = new Set(`${HTML_TAGS} ${SVG_TAGS} ${THREE_TAGS}`.split(' '));
export const THREE_TAG_PATTERN = /^[a-z][A-Za-z0-9]*(Geometry|Material|Light|Camera|Helper)$/;
