### Examples

```sh
logbook labels run --task shell
```

Label the shell calls the default model has not labelled yet.

```sh
logbook labels run --task prompt --sample 100 --model claude-sonnet-5-5
```

Label a fixed sample of 100 prompts with Sonnet, to compare it with another model.
