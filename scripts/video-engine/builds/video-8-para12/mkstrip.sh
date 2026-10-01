set -e
cd /home/heath/mw/v8
ffmpeg -nostdin -v error -y -i pg/p-06.png -i pg/p-07.png -i pg/p-08.png -filter_complex "[0]crop=1692:2248:92:50,scale=1080:-2,setsar=1[a];[1]crop=1692:2248:92:50,scale=1080:-2,setsar=1[b];[2]crop=1692:2248:92:50,scale=1080:-2,setsar=1[c];[a][b][c]vstack=inputs=3[s]" -map "[s]" strip8.png
ffprobe -v error -show_entries stream=width,height -of default=nw=1 strip8.png
