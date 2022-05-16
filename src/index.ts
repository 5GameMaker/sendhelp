
declare global {
    interface Window {
        sendhelp: ((code : string, live? : false) => Promise<string>) &
            ((code : string, live : true) => Promise<void>);
    }
}

export interface Command {
    execute : (stream : string, args : string[]) => Promise<string>;
}

export interface Extension {
    name : string;
    version : string;
    commands : { [key : string] : Command };
}

const extensions : Extension[] = [];

export async function sendhelp(code : string, live? : false) : Promise<string>;
export async function sendhelp(code : string, live : true) : Promise<void>;
export async function sendhelp(code : string, live : boolean = false) : Promise<string | void> {
    const isDebug = typeof process != 'undefined' && process.env.SENDHELP_DEBUG == '1';
    let output = '';

    enum TokenType {
        INSTANCE,
        STRING,
        ARROW,
        BRACKET,
    }

    enum ArrowType {
        LEFT_SEND,
        RIGHT_SEND,
        LEFT_JUMP,
        RIGHT_JUMP,
    }

    type Token = [TokenType, string];
    /**
     * - 1:
     * - - bit 1 - direction (left/right)
     * - - bit 2 - action (send/jump)
     * - 2: amount of heads (jump length)
     * - 3: amount of dashes (importance)
     */
    type Arrow = [ArrowType, number, number];

    /**
     * Base class for blocks
     */
    class Block {
        public left  : Arrow | null = null;
        public right : Arrow | null = null;
        public parent : BlockBranch | null = null;
    }

    /**
     * Collection of blocks
     */
    class BlockBranch extends Block {
        public blocks : Block[] = [];
        public inner : Arrow | null = null;

        private __beginBlockIndex : number[] = [];
        public get beginBlockIndex() : number[] {
            if (this.__beginBlockIndex.length)
                return this.__beginBlockIndex;

            const possibleTargets : number[] = [];

            let i = -1;
            for (const block of this.blocks) {
                i++;

                if (
                    [block.left, block.right].some(
                        (arrow, i) => arrow && arrow[0] % 2 != i && ~~(arrow[0] / 2) != 1
                    )
                ) continue;

                possibleTargets.push(i);
            }

            return this.__beginBlockIndex = possibleTargets;
        }

        public get beginBlocks() : Block[] {
            return this.beginBlockIndex.map(i => this.blocks[i]);
        }
    }

    /**
     * Function call
     */
    class Call extends Block {
        public constructor(public name : string) { super(); }

        public arguments : string[] = [];
    }

    /**
     * A string
     */
    class StringBlock extends Block {
        public constructor(public string : string) { super(); }
    }

    /**
     * Check if token is a whitespace
     * @param char A character
     */
    function isWhitespace(char : string) : boolean {
        return char.trim().length == 0;
    }

    /**
     * Show error message and quit
     *
     * @param text Error message
     */
    function panic(text : string) : never {
        if (typeof require == 'undefined' || typeof module == 'undefined' || require.main != module)
            throw Error(text);
        console.error('\x1b[31merror:', text);
        if (typeof process != 'undefined') process.exit(1);
        if (confirm(`SendHelp interpreter error: ${text}\n\nPress 'OK' to reload the page\nPress 'Cancel' to go to 'about:blank'`)) {
            location.reload();
        }
        else {
            location.replace('about:blank');
        }
        while (true) {}
    }

    /**
     * Get arrow data
     *
     * @param token Arrow token
     */
    function parseArrow(token : Token) : Arrow {
        return [
            (token[1].replace(/-/g, '').length == 1 ? 0 : 1) * 2 + (token[1].includes('<') ? 0 : 1),
            token[1].replace(/-/g, '').length,
            token[1].replace(/[^-]/g, '').length,
        ];
    }

    /**
     * Parse string into tokens
     *
     * @param string Whatever string
     * @returns List of tokens
     */
    function tokenize(string : string) : Token[] {
        const tokens : Token[] = [];

        let token : Token = [0, ""];
        let backspace = false;

        /**
         * Append token if not empty
         */
        function append() : void {
            if (token[0] == TokenType.ARROW && !token[1].match(/^(<+-*|-*>+)$/)) {
                token[0] = TokenType.INSTANCE;
            }
            if (token[0] == TokenType.STRING || token[1].length > 0)
                tokens.push(token);
            token = [0, ""];
        }

        for (const char of string) {
            repeat: while (true) {
                switch (token[0]) {
                    case TokenType.INSTANCE:
                        if (char == '"') {
                            append();
                            token[0] = TokenType.STRING;
                        }
                        else if (char.match(/[<>-]/)) {
                            append();
                            token[0] = TokenType.ARROW;
                            continue repeat;
                        }
                        else if (char.match(/[{}]/)) {
                            append();
                            token[0] = TokenType.BRACKET;
                            token[1] = char;
                            append();
                        }
                        else if (isWhitespace(char)) append();
                        else token[1] += char;
                    break;

                    case TokenType.STRING:
                        if (backspace) token[1] += char, backspace = false;
                        else if (char == '"') append();
                        else if (char == '\\') backspace = true;
                        else token[1] += char;
                    break;

                    case TokenType.ARROW:
                        if (isWhitespace(char)) append();
                        else if (char.match(/[0-9]/)) {
                            token[0] = TokenType.INSTANCE;
                            continue repeat;
                        }
                        else if (!char.match(/[<>-]/)) {
                            append();
                            continue repeat;
                        }
                        else if (!(token[1] + char).match(/^(<+-*|-+>*|>+)$/)) {
                            token[0] = TokenType.INSTANCE;
                            continue repeat;
                        }
                        else token[1] += char;
                    break;

                    default:
                        throw new Error("Not implemented.");
                }
                break repeat;
            }
        }

        if (backspace || token[0] == TokenType.STRING) panic("Unterminated string");
        append();

        return tokens;
    }

    /**
     * Make a parser tree
     *
     * @param tokens Tokens
     */
    function parse(tokens : Token[]) : BlockBranch {
        const tree = new BlockBranch();
        const stack: BlockBranch[] = [tree];

        /**
         * Append token to current block
         *
         * @param token Block or token
         */
        function append(token : Block) {
            const tree = stack[stack.length - 1];
            if (tree.blocks.length >= 1) token.left = tree.blocks.slice(-1)[0].right;
            else token.left = tree.inner;
            token.parent = tree;
            tree.blocks.push(token);
        }

        const len = tokens.length;
        for (let i = 0; i < len; i++) {
            const token = tokens[i];
            switch (token[0]) {
                case TokenType.BRACKET:
                    if (
                        stack[stack.length - 1].blocks.length > 0 &&
                        stack[stack.length - 1].blocks.slice(-1)[0].right == null
                    ) panic("Token after block");
                    if (token[1] == '{') {
                        const begin = i + 1;
                        let level = 0;
                        check: while (true) {
                            for (i++; i < len; i++) {
                                const token = tokens[i];
                                if (token[0] != TokenType.BRACKET) continue;
                                level += (token[1] == '{' ? 1 : 0) * 2 - 1;
                                if (level == -1) {
                                    if (begin == i) panic("Empty block");
                                    break check;
                                }
                            }
                            panic("Unterminated block");
                        }
                        append(parse(tokens.slice(begin, i)));
                    }
                    else if (stack.length == 1) panic("Top-level block cannot be closed with '}'");
                    else append(stack.pop()!);
                break;

                case TokenType.ARROW:
                {
                    const tree = stack[stack.length - 1];
                    if (tree.blocks.length == 0) {
                        if (tree.inner != null) panic("Arrow cannot go after another arrow");
                        tree.inner = parseArrow(token);
                    }
                    else {
                        const block = tree.blocks[tree.blocks.length - 1];
                        if (block.right != null) panic("Arrow cannot go after another arrow");
                        block.right = parseArrow(token);
                    }
                }
                break;

                case TokenType.STRING:
                case TokenType.INSTANCE:
                {
                    const tree = stack[stack.length - 1];
                    if (tree.blocks.length == 0 || tree.blocks[tree.blocks.length - 1].right != null) {
                        const block = new (token[0] == TokenType.STRING ? StringBlock : Call)(token[1]);
                        append(block);
                        break;
                    }
                    const block = tree.blocks[tree.blocks.length - 1];
                    if (block instanceof StringBlock) block.string += '\n' + token[1];
                    else if (block instanceof Call) block.arguments.push(token[1]);
                    else panic("Token after block");
                }
                break;
            }
        }

        if (tree.blocks.length > 0) {
            // Cuz IDK how to work with bit shifts
            if ((tree.blocks[0].left?.[0] || 2) / 2 < 0.7 || (tree.blocks[tree.blocks.length - 1].right?.[0] || 2) / 2 < 0.7)
                panic("Non-jump arrow at block border");
            if ((tree.blocks[0].left?.[0] || 0) % 2 == 1)
                panic("Right arrow at left block border");
            if ((tree.blocks[tree.blocks.length - 1].right?.[0] || 1) % 2 == 0)
                panic("Left arrow at right block border");
        }
        return tree;
    }

    const setTimeout = (ms? : number) => new Promise<void>(res => {
        globalThis.setTimeout(res, ms);
    });

    const input = function () : (text? : string) => Promise<string> {
        if (globalThis.window) {
            return (text = "") => Promise.resolve(prompt(text) || '');
        }
        else {
            const { createInterface } = require('readline') as typeof import('readline');
            let rl : import('readline').Interface | null = null;
            const inputRequests : [string, (out : string) => void][] = [];
            function mkint() {
                const rl = createInterface(process.stdin, process.stdout);
                rl.on('SIGINT', () => process.exit(0));
                rl.on('SIGTERM', () => process.exit(0));
                return rl;
            }
            return function requestInput(text = '') {
                if (!rl) rl = mkint();
                return new Promise<string>(res => {
                    function loop() {
                        if (!rl) rl = mkint();
                        const request = inputRequests.shift()!;
                        rl.question(request[0], str => {
                            request[1](str);
                            if (inputRequests.length) loop();
                            else {
                                rl?.close();
                                rl = null;
                            }
                        });
                    }
                    inputRequests.push([text, res]);
                    if (inputRequests.length == 1) loop();
                });
            }
        }
    }();

    class FakeProcess { // I couldn't be bothered to actually split this into different processes
        constructor(private block : Block) {
            this.endingBlock = block.parent;
        }

        private static freeID = 0;
        private endingBlock;
        private beginStream = '';
        private static storage = '';
        public readonly id = FakeProcess.freeID >= Number.MAX_SAFE_INTEGER ? void (FakeProcess.freeID = 1) || 0 : FakeProcess.freeID++;
        public static running = 0;

        public static async of(target : Block, shift : number) : Promise<Map<BlockBranch, string>> {
            const block = this.getBlockOf(target, shift);
            if (block) return new FakeProcess(block).run();
            else return new Map();
        }

        public static async desyncOf(target : Block, shift : number, stream? : string) : Promise<void> {
            const block = this.getBlockOf(target, shift);
            if (!block) return;
            const proc = new FakeProcess(block);
            proc.beginStream = stream || '';
            proc.endingBlock = null;
            await proc.run();
        }

        private static getBlockOf(target : Block, shift : number) : Block | null {
            if (!target.parent) return null;
            let current = target;
            const abs = Math.abs(shift);
            for (let i = 0; i < abs; i++) {
                if (!current.parent) return null;
                let me = current.parent.blocks.indexOf(current);
                while (shift > 0 ? me == current.parent.blocks.length - 1 : me == 0) {
                    current = current.parent;
                    if (!current.parent) return null;
                    me = current.parent.blocks.indexOf(current);
                }
                current = current.parent.blocks[shift > 0 ? me + 1 : me - 1];
                if (abs == 1) return current;
                while (current instanceof BlockBranch) {
                    current = current.blocks[shift > 0 ? 0 : current.blocks.length - 1];
                }
            }
            return current;
        }

        public async run() : Promise<Map<BlockBranch, string>> {
            FakeProcess.running++;
            const wrapped = async () => {
                const map = new Map<BlockBranch, string>();
                let stream = this.beginStream;
                function blockpos(block : Block) {
                    let i = 0;
                    while (block.parent) {
                        i += block.parent.blocks.indexOf(block);
                        block = block.parent;
                    }
                    return i;
                }
                while (true) {
                    if (FakeProcess.freeID > Number.MAX_SAFE_INTEGER - 2) FakeProcess.freeID = 0;
                    if (isDebug) console.log(`${this.id}) Running block ${blockpos(this.block)}`);
                    if (this.block instanceof BlockBranch) {
                        if (isDebug) console.log(`${this.id}) Starting subprocess with id ${FakeProcess.freeID}`);
                        const map = await Promise.all(this.block.beginBlocks.map(a => new FakeProcess(a).run()))
                            .then(maps => maps.reduce((a, b) => void b.forEach((v, k) => a.set(k, (a.get(k) || '') + v)) || a, new Map()));
                        stream += map.get(this.block) || '';
                    }
                    if (this.block instanceof Call) {
                        switch (this.block.name) {
                            case 'nothing':
                                stream = "";
                            break;
                            case 'input':
                                stream = await input(`${stream}${this.block.arguments.join('\n')}`);
                            break;
                            case 'equals':
                                stream = String(stream == this.block.arguments.join('\n'));
                            break;
                            case 'sum':
                                stream = String([Number(stream), ...this.block.arguments.map(Number)].reduce((a, b) => a + b, 0));
                            break;
                            case 'div':
                                try {
                                    stream = String(Number(stream) / Number(this.block.arguments[0] || 0));
                                } catch (_) {
                                    stream = 'NaN';
                                }
                            break;
                            case 'mod':
                                try {
                                    stream = String(Number(stream) % Number(this.block.arguments[0] || 0));
                                } catch (_) {
                                    stream = 'NaN';
                                }
                            break;
                            case 'loop':
                                FakeProcess.storage += '\n' + [stream, ...this.block.arguments].join('\n');
                            break;
                            case 'pop':
                                stream = FakeProcess.storage.split('\n').pop() || '';
                                FakeProcess.storage = FakeProcess.storage.split('\n').slice(0, -1).join('\n');
                            break;
                            case 'done':
                                stream = String(FakeProcess.storage.length == 0);
                            break;
                            case 'print':
                                if (this.block.parent?.parent) {
                                    map.set(this.block.parent, (map.get(this.block.parent) || '') + `${this.block.arguments.join('\n')}${stream}`);
                                }
                                else {
                                    (live ? typeof window == 'undefined' ? console.log : alert : (s : string) => output += s)(`${this.block.arguments.join('\n')}${stream}`);
                                }
                            break;
                            default:
                                for (const extension of extensions) {
                                    if (Object.getOwnPropertyNames(extension.commands).includes(this.block.name)) {
                                        try {
                                            stream += await extension.commands[this.block.name].execute(stream, this.block.arguments);
                                        } catch (err) {
                                            panic(String(err));
                                        }
                                        break;
                                    }
                                }
                            break;
                        }
                    }
                    if (this.block instanceof StringBlock) {
                        stream += this.block.string;
                    }

                    if (
                        (!this.block.left ||
                        this.block.left[0] % 2 != 0) &&
                        (!this.block.right ||
                        this.block.right[0] % 2 != 1)
                    ) {
                        check: while (true) {
                            while (this.block.parent && this.endingBlock != this.block.parent) {
                                this.block = this.block.parent;
                                if (
                                    this.block.left && this.block.left[0] % 2 == 0 ||
                                    this.block.right && this.block.right[0] % 2 == 1
                                ) break check;
                            }
                            if (isDebug) console.log(`${this.id}) Exiting on end`);
                            return map;
                        }
                        let a: Arrow;
                        const points = [this.block.left, this.block.right]
                            .map((a, i) => (a && a[0] % 2 == i) ? [a[1] * (i * 2 - 1), a[2]] : null)
                            .filter(a => a !== null) as [number, number][];
                        switch (points.length) {
                            case 0:
                                if (isDebug) console.log(`${this.id}) Exiting on end`);
                                return map;
                            case 2:
                                stream += map.get(this.block as BlockBranch) || '';
                                if (points[0][1] != points[1][1]) {
                                    const point = (points[0][1] > points[1][1] ? -1 : 1) * (stream == 'true' ? 1 : -1) > 0
                                        ? points[1][0]
                                        : points[0][0];
                                    const block = FakeProcess.getBlockOf(this.block, point);
                                    if (block) this.block = block;
                                    else {
                                        if (isDebug) console.log(`${this.id}) Outside the script, exiting...`);
                                        return map;
                                    }
                                    break;
                                }
                                FakeProcess.desyncOf(this.block, points[0][1], stream);
                            case 1:
                            {
                                if (points.length == 1) stream += map.get(this.block as BlockBranch) || '';
                                const block = FakeProcess.getBlockOf(this.block, points[0][1]);
                                if (block) this.block = block;
                                else {
                                    if (isDebug) console.log(`${this.id}) Outside the script, exiting...`);
                                    return map;
                                }
                            }
                            break;
                        }
                    }

                    else if (
                        this.block.left &&
                        this.block.left[0] % 2 == 0 &&
                        this.block.right &&
                        this.block.right[0] % 2 == 1
                    ) {
                        if (this.block.left[2] == this.block.right[2]) {
                            if (isDebug) {
                                console.log(`${this.id}) Splitting into two...`);
                            }
                            return await Promise.all([this.block.left, this.block.right].map(
                                (arrow, i) =>
                                (i => FakeProcess.of(this.block, i * arrow[2]))(i ? -1 : 1)
                            ))
                                .then(maps => maps.reduce((a, b) => void b.forEach((v, k) => a.set(k, (a.get(k) || '') + v)) || a))
                                .then(_map => _map.forEach((v, k) => map.set(k, (map.get(k) || '') + v)))
                                .then(() => map);
                        }
                        else {
                            const m = (this.block.left[2] > this.block.right[2] ? -1 : 1) * (stream == 'true' ? 1 : -1);
                            if (isDebug) console.log(`${this.id}) Moving ${m == -1 ? 'left' : 'right'}`);
                            const block = FakeProcess.getBlockOf(this.block, m * [this.block.left, this.block.right][(m + 1) / 2][1]);
                            if (block) this.block = block;
                            else {
                                if (isDebug) console.log(`${this.id}) Outside the script, exiting...`);
                                return map;
                            }
                        }
                    }

                    else {
                        const m = this.block.left && this.block.left[0] % 2 == 0 ? -1 : 1;
                        if (isDebug) console.log(`${this.id}) Moving ${m == -1 ? 'left' : 'right'}`);
                        const block = FakeProcess.getBlockOf(this.block, m * [this.block.left!, this.block.right!][(m + 1) / 2][1]);
                        if (block) this.block = block;
                        else {
                            if (isDebug) console.log(`${this.id}) Outside the script, exiting...`);
                            return map;
                        }
                    }

                    await setTimeout();
                }
            }
            const v = await wrapped();
            FakeProcess.running--;
            return v;
        }
    }

    const file = parse(tokenize(code));

    if (file.left || file.right || file.inner || (file.blocks.length > 0 && file.blocks[file.blocks.length - 1].right))
        panic("Arrows are not allowed at top-level block");

    if (isDebug) console.log(`MAIN) Begin blocks: [${file.beginBlockIndex.join(', ')}]`);
    file.beginBlocks.sort(() => (Math.random() - 0.5) * 2 * file.beginBlockIndex.length).forEach(i => new FakeProcess(i).run());

    await new Promise<void>(res => {
        const i = setInterval(() => {
            if (FakeProcess.running != 0) return;
            clearInterval(i);
            res();
        });
    });

    return live ? void 0 : output;
} // I'm too lazy to do things properly lol

export function extend() {}

if (typeof module != 'undefined' && require.main === module) {
    /**
     * Show program's usage
     */
    function showHelp() : void {
        console.log(`${process.argv0} - sendhelp interpreter`);
        console.log(`Usage: ${process.argv0} <filename>`);
    }

    if (process.argv.length != 3) void showHelp() || process.exit();

    import('fs/promises').then(({ readFile }) => readFile(process.argv[2], 'utf-8'))
        .then(code => sendhelp(code, true));
}
