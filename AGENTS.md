<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Research Knowledge lives in independent research-knowledge modules and read-only UI; never import its logic into trading paths because research validation must not change execution.
- Proposed schema rollout SQL is stored under docs as unapplied review material; apply schema changes only through the migration tool after explicit authorization because current production sources and retention must remain untouched.
- Research dashboard reads use canonical public credentials with RLS and explicit bounded projections, never service-role clients, because public UI must not expose raw/private entry snapshots.
