# openankerproto

An independent, open-source Python client and browser workspace for Anker Bluetooth power banks, chargers, and power stations.

**[Open the website](https://gabrieljcs.github.io/openankerproto/)** · **[Try the demo](https://gabrieljcs.github.io/openankerproto/?demo=1)**

The website connects directly over Web Bluetooth. No account, backend, or API key is required. Use a browser with Web Bluetooth support, such as desktop Chrome or Edge; demo mode works without Bluetooth. Device support varies by model and firmware.

## Python client

```sh
python -m pip install './ankerproto[ble]'
python -m ankerproto --help
```

See the [client documentation](ankerproto/README.md) and [protocol reference](ankerproto/docs/PROTOCOL.md).

## Website

```sh
cd ankerproto/web
npm run serve
```

Open http://127.0.0.1:8080. See the [website documentation](ankerproto/web/README.md) for device setup, demos, and optional local photo delivery.

## Validation and deployment

```sh
cd ankerproto/web
npm run test:all
```

GitHub Actions checks the Python client and website, builds for the repository subpath, and deploys `ankerproto/web/dist` to GitHub Pages on pushes to `main`. Set the repository's Pages source to **GitHub Actions**.

The repository excludes local research inputs, APKs, credentials, AI assistant configuration, generated builds, and browser profiles. Runtime device artwork is included so the published dashboard can render supported models.

Not affiliated with or endorsed by Anker Innovations. Use only with devices you own. Source code is MIT licensed; product names and artwork belong to their respective owners.
