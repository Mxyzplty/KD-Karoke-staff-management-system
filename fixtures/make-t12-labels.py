# SPDX-License-Identifier: AGPL-3.0-only
"""T12 labels on clip 2 (SM-P02, SM-P03; no exact alpha exists for a filmed frame): the person outlined by hand, the edge settled by GrabCut in a
band around the outline, seed fixed. Written to $CUTFRAME_FIXTURES/datasets/t12/labels/c2-f<frame>.png, 1280 x 534, 255 = person.
Traced from the frames alone, before and without looking at a matte."""
import hashlib, os
from pathlib import Path
import cv2
import numpy as np

STORE = Path(os.environ['CUTFRAME_FIXTURES'])
OUT = STORE / 'datasets/t12/labels'
CLIP = STORE / 'corpus/tos-action-30s.mp4'
OUTLINES = {
    12: [(660, 0), (632, 90), (628, 170), (645, 240), (655, 290), (670, 330), (695, 400), (720, 430), (660, 470), (620, 510), (525, 533), (1115, 533), (1110, 495), (1030, 460), (985, 410), (950, 380), (955, 300), (975, 240), (975, 190), (968, 130), (955, 60), (930, 0)],
    36: [(655, 0), (625, 90), (625, 170), (640, 240), (640, 290), (665, 360), (690, 425), (650, 470), (655, 510), (525, 533), (1112, 533), (1110, 500), (1030, 460), (980, 405), (950, 380), (965, 320), (995, 255), (970, 190), (975, 120), (955, 50), (935, 0)],
    48: [(655, 0), (620, 100), (622, 190), (640, 250), (640, 310), (665, 375), (690, 420), (650, 460), (660, 510), (520, 533), (1115, 533), (1115, 500), (1035, 470), (985, 415), (950, 390), (965, 320), (990, 260), (970, 190), (975, 110), (950, 40), (930, 0)],
    62: [(0, 0), (448, 0), (448, 10), (425, 90), (425, 130), (440, 180), (458, 250), (435, 285), (432, 320), (420, 370), (385, 420), (340, 445), (300, 490), (280, 533), (0, 533)],
    648: [(640, 0), (580, 90), (578, 150), (600, 230), (605, 290), (640, 370), (680, 420), (620, 460), (610, 500), (500, 533), (1085, 533), (1060, 510), (1050, 470), (1000, 400), (930, 390), (890, 350), (885, 300), (905, 250), (920, 180), (895, 130), (880, 60), (830, 10), (780, 0)],
    672: [(680, 0), (640, 10), (610, 70), (605, 170), (610, 250), (640, 330), (680, 400), (640, 420), (620, 480), (545, 533), (1060, 533), (1055, 480), (1000, 420), (935, 395), (895, 360), (900, 320), (925, 270), (945, 190), (935, 120), (905, 50), (850, 10), (800, 0)],
}
OUTSIDE, INSIDE = 12, 20


def label(frame, outline):
    region = np.zeros(frame.shape[:2], np.uint8)
    cv2.fillPoly(region, [np.array(outline, np.int32)], 1)
    disc = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    mask = np.full(frame.shape[:2], cv2.GC_BGD, np.uint8)
    mask[cv2.dilate(region, disc(OUTSIDE)) > 0] = cv2.GC_PR_BGD
    mask[region > 0] = cv2.GC_PR_FGD
    mask[cv2.erode(region, disc(INSIDE), borderType=cv2.BORDER_CONSTANT, borderValue=1) > 0] = cv2.GC_FGD
    cv2.grabCut(frame, mask, None, np.zeros((1, 65)), np.zeros((1, 65)), 5, cv2.GC_INIT_WITH_MASK)
    return np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cv2.setRNGSeed(0)
    cap = cv2.VideoCapture(str(CLIP))
    for number, outline in OUTLINES.items():
        cap.set(cv2.CAP_PROP_POS_FRAMES, number)
        frame = cap.read()[1]
        made = label(frame, outline)
        cv2.imwrite(str(OUT / f'c2-f{number}.png'), made)
        print(number, f'area {(made > 0).mean():.4f}', hashlib.sha256((OUT / f'c2-f{number}.png').read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
