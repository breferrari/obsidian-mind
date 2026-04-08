# Project Archive

Move a completed project from `work/active/` to `work/archive/YYYY/` and update all indexes.

## Usage

```
/om-project-archive <project name>
```

## Workflow

### 1. Find the Note

Search `work/active/` for the project name. Confirm with the user before proceeding.

### 2. Update Frontmatter

- Set `status: completed`
- Verify `quarter` property is set correctly
- Verify `description` reflects the final state

### 3. Move the File

```bash
git mv "work/active/<Note>.md" "work/archive/YYYY/"
```

Use the year from the note's `date` field.

### 4. Update Indexes

- **`work/Index.md`**: Move from Active Projects to the appropriate Completed quarter section
- **`brain/North Star.md`**: Mark as completed in Current Focus if listed there
- **`perf/Brag Doc.md`**: Verify the project is captured in the relevant quarter's highlights
- **`brain/Memories.md`**: Update Recent Context if the project is mentioned as "in progress"

### 5. Verify

- Run a quick check that no wikilinks are broken (Obsidian resolves by name, so moves shouldn't break links)
- Confirm the Work Dashboard Base shows the note in "Completed" view, not "Active Work"

## Important

- Always use `git mv` — never copy+delete
- Don't archive without user confirmation
- If the project has sub-notes (like incidents have RCA + deep dive), ask if those should move too
