---
description: "Morning kickoff. Load today's context, review yesterday, surface open tasks, and identify priorities."
---

Run the morning standup:

1. Read `Home.md` for current dashboard state
2. Read `brain/North Star.md` for current goals
3. Check `work/Index.md` for active projects
4. Read yesterday's and today's daily notes if they exist: `obsidian daily:read`
5. List open tasks: `obsidian tasks daily todo`
6. Check recent git activity: `git log --oneline --since="24 hours ago" --no-merges`
7. Check for any unlinked notes or inbox items needing processing

Present a structured standup summary:
- **Yesterday**: What got done (from git log and daily note)
- **Active Work**: Current projects in work/active/ with their status
- **Open Tasks**: Pending items
- **North Star Alignment**: How active work maps to current goals
- **Suggested Focus**: What to prioritize today based on goals + open items

Keep it concise. This is a quick orientation, not a deep dive.
