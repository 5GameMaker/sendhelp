# SendHelp interpreter

If anyone saw you using this, you would've ended up in a hospital.

## Why?

Big tech can't go opensource because overwise people will discover all their dirty secrets. SendHelp
was designed to be unreadable for human beings, therefore not only any sort of obfuscation would be
unneeded, also they'll be able to safely post all their code in public repos without any of their
shady stuff being exposed.

## How to use this thing?

Install NodeJS, launch the terminal from project's directory and enter `npm run build`. You'll find
SendHelp interpreter in the `./build` folder after the build'll be finished.

Do `node path/to/sendhelp path/to/file` to run your sendhelp script.

It can also be used as a module and in browser
```html
<script src="path/to/build/index.browser.js"></script>
```
```ts
import { sendhelp } from '@buj351/sendhelp';
```
