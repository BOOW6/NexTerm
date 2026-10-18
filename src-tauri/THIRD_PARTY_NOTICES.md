# Third-party notices

## Microsoft Windows Console ConPTY

NexTerm bundles the redistributable ConPTY binaries through the
[`conpty-assets`](https://crates.io/crates/conpty-assets) crate:

- Upstream package: `Microsoft.Windows.Console.ConPTY` **1.25.260930003**
- Files: `conpty.dll` and `OpenConsole.exe` (x64, unmodified and signed)
- SHA-256:
  - `conpty.dll`: `feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a`
  - `OpenConsole.exe`: `3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586`

The binaries are extracted at runtime to the application's local data directory
next to this notice. `conpty-assets` is an unofficial packaging of Microsoft's
official NuGet assets and is not affiliated with or endorsed by Microsoft.

### Microsoft license

Copyright (c) Microsoft Corporation. All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
