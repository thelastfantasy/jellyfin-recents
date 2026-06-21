#!/usr/bin/env python3
"""
Ideal-quality reference stitcher using OpenCV's full panorama pipeline.

cv2.Stitcher_PANORAMA uses:
  - SIFT/ORB feature detection
  - Bundle adjustment (minimises reprojection error across all frames)
  - Wave-corrected cylindrical/spherical projection
  - Graph-cut seam finding
  - Multi-band (Laplacian-pyramid) blending

This is intended as a quality ceiling to compare against the Rust AKAZE
implementation.  Falls back to manual AKAZE+RANSAC if Stitcher fails.
"""
import sys
import numpy as np
import cv2
from pathlib import Path


def stitch_ideal(img_a: np.ndarray, img_b: np.ndarray) -> np.ndarray:
    """Use cv2.Stitcher (full pipeline) for the highest quality result."""
    stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
    status, result = stitcher.stitch([img_a, img_b])
    if status == cv2.Stitcher_OK:
        return result
    print(f"[stitch_py] cv2.Stitcher failed (status={status}), trying SCANS mode",
          file=sys.stderr)
    stitcher2 = cv2.Stitcher_create(cv2.Stitcher_SCANS)
    status2, result2 = stitcher2.stitch([img_a, img_b])
    if status2 == cv2.Stitcher_OK:
        return result2
    print(f"[stitch_py] SCANS mode also failed (status={status2}), falling back to AKAZE",
          file=sys.stderr)
    return stitch_akaze(img_a, img_b)


def stitch_akaze(img_a: np.ndarray, img_b: np.ndarray) -> np.ndarray:
    """Manual AKAZE + RANSAC + canvas expansion (same algorithm as Rust, for fallback)."""
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)
    akaze = cv2.AKAZE_create(threshold=0.001)
    kp_a, desc_a = akaze.detectAndCompute(gray_a, None)
    kp_b, desc_b = akaze.detectAndCompute(gray_b, None)
    if len(kp_a) < 4 or len(kp_b) < 4:
        return img_a
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    matches = sorted(matcher.match(desc_a, desc_b), key=lambda m: m.distance)
    matches = matches[:max(4, int(len(matches) * 0.3))]
    pts_a = np.float32([kp_a[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    pts_b = np.float32([kp_b[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    H, _ = cv2.findHomography(pts_a, pts_b, cv2.RANSAC, 3.0)
    if H is None:
        return img_a
    H_inv = np.linalg.inv(H)
    h_a, w_a = img_a.shape[:2]
    h_b, w_b = img_b.shape[:2]
    b_corners = np.float32([[0,0],[w_b-1,0],[0,h_b-1],[w_b-1,h_b-1]]).reshape(-1,1,2)
    b_in_a = cv2.perspectiveTransform(b_corners, H_inv).reshape(-1, 2)
    a_corners = np.float32([[0,0],[w_a-1,0],[0,h_a-1],[w_a-1,h_a-1]])
    all_pts = np.vstack([a_corners, b_in_a])
    min_x, min_y = np.floor(all_pts.min(axis=0)).astype(int)
    max_x, max_y = np.ceil(all_pts.max(axis=0)).astype(int)
    off_x, off_y = max(0, -min_x), max(0, -min_y)
    canvas_w, canvas_h = max_x - min_x + 1, max_y - min_y + 1
    T_inv = np.array([[1,0,-off_x],[0,1,-off_y],[0,0,1]], dtype=np.float64)
    H_new = H @ T_inv
    warped_b = cv2.warpPerspective(img_b, H_new, (canvas_w, canvas_h))
    canvas_a = np.zeros((canvas_h, canvas_w, img_a.shape[2]), dtype=np.uint8)
    canvas_a[off_y:off_y+h_a, off_x:off_x+w_a] = img_a
    mask_a = np.zeros((canvas_h, canvas_w), dtype=np.float32)
    mask_a[off_y:off_y+h_a, off_x:off_x+w_a] = 1.0
    mask_b = (warped_b.sum(axis=2) > 0).astype(np.float32)
    total = (mask_a + mask_b).clip(min=1e-6)
    result = np.zeros_like(canvas_a, dtype=np.float32)
    for c in range(img_a.shape[2]):
        result[:,:,c] = (canvas_a[:,:,c].astype(np.float32) * mask_a
                         + warped_b[:,:,c].astype(np.float32) * mask_b) / total
    return result.clip(0, 255).astype(np.uint8)


def main():
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} input_a.png input_b.png output.png")
        sys.exit(1)
    img_a = cv2.imread(str(sys.argv[1]))
    img_b = cv2.imread(str(sys.argv[2]))
    if img_a is None or img_b is None:
        print("Failed to load input images", file=sys.stderr)
        sys.exit(1)
    result = stitch_ideal(img_a, img_b)
    out_path = str(sys.argv[3])
    cv2.imwrite(out_path, result)
    print(f"Saved: {out_path} ({result.shape[1]}x{result.shape[0]})")


if __name__ == "__main__":
    main()
