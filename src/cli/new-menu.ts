// Name: New
// Description: Script Kit

import { Choice } from "../types/core"
import { Main, CLI } from "./index"
import {
  kitMode,
  returnOrEnter,
  run,
} from "../core/utils.js"
import { addPreview, findDoc } from "./lib/utils.js"

setFlags({})

let newOptions: Choice<keyof CLI | keyof Main>[] = [
  {
    name: "New Script",
    description: `Create a script using ${
      kitMode() === "ts" ? "TypeScript" : "JavaScript"
    }`,
    value: "new",
  },
  {
    name: "New from URL/Gist",
    description: "Create a script from a URL or Gist",
    value: "new-from-url",
  },
  // {
  //   name: "Download Script From URL",
  //   description: "Enter a url then name it",
  //   value: "new-from-url",
  // },
  {
    name: "Browse Community Examples",
    description:
      "Visit scriptkit.com/scripts/ for a variety of examples",
    value: "browse-examples",
  },
  // {
  //   name: "Create Scripts from Tips",
  //   description:
  //     "The Tips tab has many helpful snippets to choose from",
  //   value: "tips",
  // },
  {
    name: "New Kit Environment",
    description: `Create a kenv for scripts`,
    value: "kenv-create",
  },
  {
    name: "Link Existing Kit Environment",
    description: "Link local kenv from your hard drive",
    value: "kenv-add",
  },
  {
    name: "Clone Kit Environment Repository",
    description: `Clone a kenv repo `,
    value: "kenv-clone",
  },
]
let previewChoices: Choice[] = await addPreview(
  newOptions,
  "new"
)

let onNoChoices = async input => {
  if (input) {
    let scriptName = input
      .replace(/[^\w\s]/g, "")
      .replace(/\s/g, "-")
      .toLowerCase()

    setPanel(
      md(`# Create <code>${scriptName}</code>

Type <kbd>${returnOrEnter}</kd> to create a script named <code>${scriptName}</code>
    `)
    )
  }
}

let cliScript = await arg<keyof CLI | keyof Main>(
  {
    placeholder: "Create a new script",
    strict: false,
    onNoChoices,
    input: arg?.input,
    shortcuts: [],
    enter: "Run",
  },
  previewChoices
)
if (cliScript === "snippets" || cliScript === "templates") {
  await run(kitPath("main", `${cliScript}.js`))
} else if (cliScript === "tips") {
  await mainScript("", "tips")
} else if (flag?.discuss) {
  let doc = await findDoc("templates", cliScript)
  if (doc?.discussion) {
    browse(doc?.discussion)
  }
} else if (
  newOptions.find(script => script.value === cliScript)
) {
  await run(kitPath(`cli`, cliScript + ".js"))
} else {
  await run(
    `${kitPath("cli", "new")}.js ${cliScript
      .replace(/\s/g, "-")
      .toLowerCase()} --scriptName '${cliScript}'`
  )
}

export {}
