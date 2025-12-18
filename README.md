# Staff Leave Manager (local-only)

Simple, single‑page web app to track Annual Leave and Medical Leave (SL/HL/TC) for multiple employees. No server required; data is stored in your browser's localStorage. Use Export/Import for backups.

How to run locally
- Quick preview: Open index.html in a browser (Chrome/Edge). Export/Import works; Cloud buttons require server.
- With serverless (recommended): Install Vercel CLI, run `vercel dev` to emulate API routes locally, then visit http://localhost:3000

Key features
- Employees: add, edit, delete; set annual leave entitlement per year (Carry Forward + Current Year)
- Leaves: record Annual, SL, HL, TC, and other miscellaneous leaves; working days auto-calculated (Mon–Fri)
- Filters and search; edit/delete entries
- Report: printable Staff Leave Card per employee and year
- Import/Export JSON backup

Cloud sync (Vercel Blob)
Deprecated: the app now uses a database. The Sync button refreshes from the server.

Deploy to GitHub + Vercel
1) Initialize git and push to GitHub
	 - Create an empty GitHub repo (e.g., leave-manager).
	 - In VS Code terminal:
		 - git init
		 - git add .
		 - git commit -m "Initial commit"
		 - git branch -M main
		 - git remote add origin https://github.com/<you>/leave-manager.git
		 - git push -u origin main
2) Import the repo in Vercel (New Project → Import from GitHub). Framework: “Other” (Static).
3) Add Vercel Postgres: In Vercel → Storage → Postgres → Create and Link to this project. Vercel will add POSTGRES_URL environment variables automatically.
4) Realtime (optional but recommended): Add Pusher Channels from the Pusher dashboard and add these Environment Variables in Vercel → Project → Settings → Environment Variables
	- PUSHER_APP_ID
	- PUSHER_KEY (public)
	- PUSHER_SECRET
	- PUSHER_CLUSTER (e.g., ap1, us3)
	Redeploy. Clients will auto‑refresh within seconds on any change.

Notes on privacy
- The demo config stores blobs as public for simplicity. Switch to private access in api/save.js and implement signed downloads if you need privacy.

Notes
- Working days exclude weekends and custom holidays list is not yet exposed in UI.
- If a leave spans across years, the report counts only the working days that fall inside the selected year.
- This is a demo; adapt to your policy (lead time, approvals, attachments).

Customization ideas
- Add a Holidays settings page
- Add approval workflow and user roles
- Hook up to a database/API
	- For richer multi-user setups use Supabase or a traditional database and migrate `employees` and `leaves` to server tables.
