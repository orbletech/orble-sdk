# Orble SDK

Python and TypeScript packages for [Orble](https://orble.tech), Linux boxes for agents.

- [python/](python/): `pip install orble-sdk`
- [js/](js/): `npm install @orble/sdk`

```python
import orble

box = orble.create()
print(box.exec("echo hello").stdout)
box.delete()
```

[Docs](https://orble.tech/docs?tab=sdk) · MIT
