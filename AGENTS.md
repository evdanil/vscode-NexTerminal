# Repository Instructions

Always prefix shell commands with `rtk` in this repository.

When running command chains, prefix each command segment separately, for example:

```bash
rtk git status && rtk npm run compile
```

Use raw commands only when debugging `rtk` itself or when explicitly requested by the user.
