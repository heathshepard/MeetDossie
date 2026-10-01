set -e
cd /home/heath/mw/v8
# The background must be EXACTLY the master video's length, never longer. The
# subject is composited with overlay ... eof_action=pass, which passes the
# background through UNCHANGED once the subject stream ends -- it does not hold
# his last frame. A background 0.09s longer than the master therefore deleted him
# from the final 0.09s, and tpad then cloned that empty frame for the whole 0.33s
# outro. The first v8 render shipped 0.42s with no presenter in it.
D=33.366667     # = v8_master.mov video duration (1001 frames @ 30fps)

# Clause rectangles on strip8.png (1080x4302 = pages 6,7,8 of the BLANK
# promulgated 20-19, each cropped to its printed border and scaled to 1080 wide,
# so page 7 begins at strip y=1434). Measured off a gridded render of p-07:
#   bold operative sentence  x 86  y 1608 w 951 h 48
#     ("...12B(1) and 12B(2) below shall be applied to and shall not change
#       the parties' obligations to pay compensation pursuant to those
#       agreements." -- the form itself sets this sentence in bold, and it sits
#       directly above the (1)/(2) boxes, which is exactly what Heath says.)
#   the words "shall not change"  x 674 y 1612 w 214 h 23
#   12B(1) item (Seller contributes toward BUYER's broker)  x 56 y 1670 w 978 h 45
#   the "____%" blank inside 12B(1)  x 730 y 1673 w 84 h 19
#
# Scroll: starts mid-page-6 (dense body text behind the hook card, page seam at
# frame y~554, well below the hook's type) and scrolls DOWN -- the natural
# "looking for paragraph 12" motion -- parking at Y=1179 by 8.40s, which puts
# the bold sentence at frame y 430-472 and the 12B(1) boxes at 491-536: above
# the caption line (baseline ~y915) and clear of his head.
Y="if(lt(t,2.40), 900+(60/2.40)*t,\
 if(lt(t,8.40), 960+(219/6.00)*(t-2.40),\
 if(lt(t,16.60), 1179+(8/8.20)*(t-8.40),\
 if(lt(t,24.50), 1187+(6/7.90)*(t-16.60),\
 1193+(5/9.30)*(t-24.50)))))"

# Cue times are read off a transcript of the FINISHED audio (sp/tr_c.json):
#   10.44 "The contribution gets applied to..."   -> clause box at 10.30
#   15.28 "Shall"                                 -> "shall not change" at 15.20
#   16.72 "So the seller's 2% comes in"           -> 12B(1) box at 16.60
#   17.36 "2%"                                    -> the % blank at 17.25
ffmpeg -nostdin -v error -y -loop 1 -framerate 30 -t $D -i strip8.png -filter_complex "\
[0:v]format=rgba,\
drawbox=x=86:y=1608:w=951:h=48:color=0xF5C543@0.20:t=fill:enable='gte(t,10.30)',\
drawbox=x=86:y=1608:w=951:h=48:color=0xC9A96E@0.92:t=4:enable='gte(t,10.30)',\
drawbox=x=674:y=1612:w=214:h=23:color=0xE8836B@0.22:t=fill:enable='gte(t,15.20)',\
drawbox=x=674:y=1612:w=214:h=23:color=0xE8836B@0.98:t=4:enable='gte(t,15.20)',\
drawbox=x=56:y=1670:w=978:h=45:color=0x8BA888@0.24:t=fill:enable='gte(t,16.60)',\
drawbox=x=56:y=1670:w=978:h=45:color=0x6E9A6B@0.95:t=4:enable='gte(t,16.60)',\
drawbox=x=730:y=1673:w=84:h=19:color=0x6E9A6B@0.30:t=fill:enable='gte(t,17.25)',\
drawbox=x=730:y=1673:w=84:h=19:color=0x4F7D4C@0.98:t=3:enable='gte(t,17.25)',\
crop=1080:1920:0:'$Y',\
ass=chips.ass:fontsdir=/home/heath/.local/share/fonts,\
eq=brightness=-0.13:contrast=0.96,format=yuv420p,fps=30[v]" \
 -map "[v]" -an -c:v libx264 -crf 16 -preset medium -r 30 -t $D bgdoc.mp4
ffprobe -v error -show_entries stream=width,height -show_entries format=duration -of default=nw=1 bgdoc.mp4
echo bgdoc-ok
