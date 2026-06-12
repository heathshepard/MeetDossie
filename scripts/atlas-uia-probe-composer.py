"""Probe UIA tree of Heath's Chrome to find the comment composer.

Assumes the FB modal is already open (composer visible). Dumps any UIA
element whose name contains 'comment' or 'write' or 'reply' to find the
actual label/control_type combo to target.
"""
import sys
import time
import pygetwindow as gw
import uiautomation as uia


def find_chrome_window():
    for w in gw.getAllWindows():
        try:
            if w.visible and not w.isMinimized and "Google Chrome" in (w.title or "") and w.width >= 1000:
                return w
        except Exception:
            continue
    return None


def get_chrome_uia(win):
    for c in uia.GetRootControl().GetChildren():
        try:
            if c.ClassName == "Chrome_WidgetWin_1":
                r = c.BoundingRectangle
                if abs(r.left - win.left) <= 8 and abs(r.top - win.top) <= 8:
                    return c
        except Exception:
            continue
    return None


def walk(node, depth=0, max_depth=40, hits=None):
    if hits is None:
        hits = []
    if depth > max_depth:
        return hits
    try:
        name = (node.Name or "")
        ct = node.ControlTypeName
        lower = name.lower()
        if any(kw in lower for kw in ("comment as", "write a comment", "write a public", "add a comment", "your comment", "reply", "post a comment")):
            r = node.BoundingRectangle
            try:
                w = r.width(); h = r.height()
            except Exception:
                w = h = 0
            hits.append({
                "name": name,
                "control_type": ct,
                "rect": (r.left, r.top, r.right, r.bottom),
                "size": (w, h),
                "depth": depth,
            })
    except Exception:
        pass
    try:
        for ch in node.GetChildren():
            walk(ch, depth + 1, max_depth, hits)
    except Exception:
        pass
    return hits


def main():
    win = find_chrome_window()
    if not win:
        print("NO CHROME WINDOW")
        sys.exit(1)
    print(f"Chrome: {win.title} {win.left},{win.top} {win.width}x{win.height}")
    cwin = get_chrome_uia(win)
    if not cwin:
        print("NO UIA WINDOW")
        sys.exit(1)
    hits = walk(cwin)
    print(f"\nFound {len(hits)} candidates:\n")
    for h in hits:
        print(f"  [{h['control_type']}] depth={h['depth']} size={h['size']} rect={h['rect']}")
        print(f"      name={h['name'][:120]!r}")
    print()


if __name__ == "__main__":
    main()
