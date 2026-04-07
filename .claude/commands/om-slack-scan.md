# Slack Deep Scan

Deep scan Slack channels and DMs for evidence involving a specific person or project. Extracts every touchpoint with timestamps for review evidence or project documentation.

## Usage

```
/slack-scan <target> [channels...] [date-range]
```

Examples:
- `/slack-scan "Jane Doe" C0EXAMPLE1 C0EXAMPLE2 "after:2026-03-16"`
- `/slack-scan "project:example" C0EXAMPLE1 C0EXAMPLE2 C0EXAMPLE3 C0EXAMPLE4`

## Workflow

1. **Read each channel** fully (paginate with cursor until all messages are fetched):
   ```
   mcp slack_read_channel channel_id=<id> limit=100
   ```

2. **Search for the person** across public+private channels:
   ```
   mcp slack_search_public_and_private query="from:<@USER_ID> after:<date>"
   mcp slack_search_public_and_private query="<Name> after:<date> -from:<@USER_ID>"
   ```

3. **Check DMs** the user points to. Read full history for the relevant period.

4. **For each message involving the target**, extract:
   - Timestamp and channel
   - What was said/done
   - Context (what prompted it, what followed)
   - Whether it's evidence of: technical work, leadership, collaboration, problem-solving, initiative

5. **Organize by date** with clear headers per day. Separate:
   - **Project evidence** → goes to the relevant work note
   - **Review/personal context** → goes to people notes or review prep notes
   - **Team dynamics** → goes to people notes

6. **Flag items that need correction** in existing vault notes.

## Important

- Be meticulous — timestamps matter for evidence
- Capture exact quotes when they show initiative, leadership, or problem-solving
- Note when the person was tagged by others (shows they're a go-to person)
- Separate project work from review prep from personal conversations
- Don't mix contexts — put data where it belongs in the vault
- Check for threads (slack_read_thread) when a message has replies
- Look for screen recordings, files shared, PRs linked
