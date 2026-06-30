Add one .txt file per Instagram account here.

File names: cookies_1.txt, cookies_2.txt, cookies_3.txt, etc.

Each file must contain exactly these 3 lines:
  sessionid=your_session_id_here
  csrftoken=your_csrf_token_here
  ds_user_id=your_numeric_user_id_here

How to get these values:
  1. Open Chrome and go to https://www.instagram.com
  2. Log in to an Instagram account
  3. Press F12 to open DevTools
  4. Click Application tab → Cookies → https://www.instagram.com
  5. Find and copy sessionid, csrftoken, ds_user_id

Each account = one parallel worker = ~1 extra reel per 2.5 seconds of throughput.
5 accounts = ~5x faster than a single account.

When you're done with this project, delete the entire C:\reels-tracker folder.
