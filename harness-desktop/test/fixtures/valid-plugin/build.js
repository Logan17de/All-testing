import { writeFile } from 'node:fs/promises'

await writeFile('built.txt', 'built successfully\n')
