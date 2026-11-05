# SPDX-License-Identifier: AGPL-3.0-only
"""Generate the Cutframe parity fixture media S1-S5 (synthetic, D9). Our own inputs; no Xapp material.
Run: py -3 make_synthetic.py   (needs ffmpeg on PATH; recorded hashes were made with ffmpeg 8.1.2). Output: $CUTFRAME_FIXTURES/synthetic. Re-running overwrites the outputs deterministically
(same ffmpeg version -> same bytes, except container timestamps where ffmpeg writes none with -fflags +bitexact).
"""
import subprocess, os, sys

STORE = os.environ.get('CUTFRAME_FIXTURES', r'C:\Users\owner\cutframe-fixtures')
OUT = os.environ.get('CUTFRAME_SYNTHETIC_OUT', os.path.join(STORE, 'synthetic'))
CORPUS = os.path.join(STORE, 'corpus')
os.makedirs(OUT, exist_ok=True)
BX = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1']

def run(args, name):
    path = os.path.join(OUT, name)
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error'] + args + [path]
    print(name, ':', ' '.join(cmd))
    subprocess.run(cmd, check=True)
    return path

# frame counter + moving bar, portrait 1080x1920 @30 fps, 10 s, silent
DRAW_PORTRAIT = ("drawbox=x='mod(t*360\\,1080)':y=1500:w=120:h=120:color=red@1:t=fill,"
                 "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{eif\\:n\\:d\\:4}':fontcolor=white:fontsize=260:x=(w-text_w)/2:y=600:box=1:boxcolor=black@0.6,"
                 "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='t=%{pts\\:hms}':fontcolor=yellow:fontsize=70:x=60:y=60")
DRAW_LAND = ("drawbox=x='mod(t*600\\,1920)':y=900:w=120:h=120:color=red@1:t=fill,"
             "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{eif\\:n\\:d\\:4}':fontcolor=white:fontsize=220:x=(w-text_w)/2:y=300:box=1:boxcolor=black@0.6")

# S1: frame-numbered portrait video, silent
run(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=10', '-vf', DRAW_PORTRAIT,
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0'] + BX, 'S1-framecount-1080x1920-30fps-10s.mp4')

# S2: frame-numbered landscape video + 1 kHz tone burst (100 ms) at every whole second, 48 kHz stereo
run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10',
     '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t\\,1)\\,0.1)\\,0.5*sin(2*PI*1000*t)\\,0)|if(lt(mod(t\\,1)\\,0.1)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=10",
     '-vf', DRAW_LAND, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0',
     '-c:a', 'aac', '-b:a', '192k', '-shortest'] + BX, 'S2-framecount-tone-1920x1080-30fps-10s.mp4')

# S3: test stills 1080x1920
run(['-f', 'lavfi', '-i', 'gradients=size=1080x1920:c0=0x000000:c1=0xffffff:x0=0:y0=960:x1=1079:y1=960:nb_colors=2:duration=0.04:speed=0', '-frames:v', '1'], 'S3a-gradient-1080x1920.png')
act = os.path.join(CORPUS, 'tos-action-30s.mp4')
if os.path.exists(act):
    run(['-ss', '13.0', '-i', act, '-frames:v', '1', '-vf', 'scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black'], 'S3b-corpus-frame-tos-action-13s-1080x1920.png')
run(['-f', 'lavfi', '-i', 'color=c=black@0.0:size=1080x1920,format=rgba', '-frames:v', '1',
     '-vf', "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='TEXT':fontcolor=white:fontsize=300:x=(w-text_w)/2:y=(h-text_h)/2"], 'S3c-text-on-alpha-1080x1920.png')

# S4: 3 s solid black (known background for text oracles)
run(['-f', 'lavfi', '-i', 'color=c=black:size=1080x1920:rate=30:duration=3', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-bf', '0'] + BX, 'S4-black-1080x1920-3s.mp4')

# S5: problem media, 3 s each, from S2's pattern
src = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3']
# VFR: drop frames irregularly (keep frames whose index is not a multiple of 7 or 11), variable timestamps
run(src + ['-vf', "select='not(eq(mod(n\\,7)\\,3))*not(eq(mod(n\\,11)\\,5))*not(eq(mod(n\\,13)\\,8))'", '-fps_mode', 'passthrough', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac'] + BX, 'S5a-vfr.mp4')
# HDR10 PQ (HEVC 10-bit, BT.2020 / SMPTE 2084 tags)
run(src + ['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=error',
           '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', '-c:a', 'aac'] + BX, 'S5b-hdr10-pq-hevc10.mp4')
# HLG (HEVC 10-bit, ARIB STD-B67)
run(src + ['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
           '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', '-c:a', 'aac'] + BX, 'S5c-hlg-hevc10.mp4')
# rotation flag 90 degrees (display matrix), H.264
rot = run(src + ['-c:v', 'libx264', '-crf', '20', '-c:a', 'aac'] + BX, 'S5d-rotate-src.mp4')
run(['-display_rotation', '90', '-i', rot, '-c', 'copy'], 'S5d-rotation-90.mp4')
os.remove(rot)
# AC-3 and E-AC-3 audio in MP4
run(src + ['-c:v', 'libx264', '-crf', '20', '-c:a', 'ac3', '-b:a', '192k'] + BX, 'S5e-ac3-audio.mp4')
run(src + ['-c:v', 'libx264', '-crf', '20', '-c:a', 'eac3', '-b:a', '192k'] + BX, 'S5f-eac3-audio.mp4')
# MKV container (H.264 + Opus)
# The original S5g remains a stored reference: its random Matroska SegmentUID
# makes regeneration non-reproducible. This distinct sibling fixes the generator.
run(src + ['-c:v', 'libx264', '-crf', '20', '-c:a', 'libopus', '-b:a', '128k'] + BX, 'S5g-container-bitexact.mkv')
# ProRes 422 MOV
run(src + ['-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le'], 'S5h-prores422.mov')
# HEVC 10-bit SDR MP4
run(src + ['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac'] + BX, 'S5i-hevc10-sdr.mp4')
print('done')
