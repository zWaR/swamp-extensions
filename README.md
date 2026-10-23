# swamp-extensions

Extensions for [swamp](https://github.com/swamp-club/swamp), published under the `@cachehit` collective.

| Extension                         | Description                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`@cachehit/techdocs`](techdocs/) | Search and AI context building for a Hugo documentation site, read from GitLab or a local checkout |

## Development

Each extension lives in its own directory with a `manifest.yaml`, a `deno.json` and its code under `extensions/`. From
the extension directory:

```bash
deno task check && deno task lint && deno task fmt:check && deno task test
swamp extension quality manifest.yaml
```

## License

Apache-2.0. See [LICENSE](LICENSE).
