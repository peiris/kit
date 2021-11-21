import { Choice, Choices, Panel, PromptConfig } from "../types/core"

import { EditorConfig, MessageData } from "../types/kitapp"

import {
  filter,
  map,
  merge,
  NEVER,
  Observable,
  of,
  share,
  switchMap,
  take,
  takeUntil,
  tap,
  debounceTime,
  withLatestFrom
} from "@johnlindquist/kit-internal/rxjs"
import { minimist } from "@johnlindquist/kit-internal/minimist"
import { stripAnsi } from "@johnlindquist/kit-internal/strip-ansi"
import { Convert } from "@johnlindquist/kit-internal/ansi-to-html"

import { Mode, Channel, UI } from "../core/enum.js"
import { assignPropsTo } from "../core/utils.js"
import { Rectangle } from "../types/electron"

interface AppMessage {
  channel: Channel
  value?: any
  input?: string
  tab?: string
  flag?: string
  index?: number
  id?: string
}

interface DisplayChoicesProps {
  choices: PromptConfig["choices"],
  className: string,
  onNoChoices: PromptConfig["onNoChoices"],
  onChoices: PromptConfig["onChoices"],
  input: string
}
let displayChoices = async (
  { choices,
    className,
    onNoChoices,
    onChoices,
    input }: DisplayChoicesProps
) => {
  switch (typeof choices) {
    case "string":
      global.setPanel(choices, className)
      break

    case "object":
      let resultChoices = checkResultInfo(choices)
      global.setChoices(resultChoices, className)


      if (resultChoices?.length > 0 && typeof onChoices === "function") {
        await onChoices(input)
      }

      if (resultChoices?.length === 0 && input?.length > 0 && typeof onNoChoices === "function") {
        await onNoChoices(input)
      }
      break
  }
}

let checkResultInfo = result => {
  if (result?.preview) {
    global.setPanel(result.preview, result?.className || "")
  }
  if (result?.panel) {
    global.setPanel(result.panel, result?.className || "")
  }
  if (result?.hint) {
    global.setHint(result.hint)
  }
  if (result?.choices) {
    return result.choices
  }

  return result
}

let promptId = 0

interface PromptContext {
  promptId: number
  tabIndex: number
}
interface InvokeChoicesProps extends DisplayChoicesProps {
  ct: PromptContext
}
let invokeChoices = async (props: InvokeChoicesProps) => {

  let resultOrPromise = (props.choices as Function)(props.input)

  if (resultOrPromise && resultOrPromise.then) {
    let result = await resultOrPromise

    if (
      props.ct.promptId === promptId &&
      props.ct.tabIndex === global.onTabIndex
    ) {
      displayChoices({ ...props, choices: result, })
      return result
    }
  } else {
    displayChoices({ ...props, choices: resultOrPromise })
    return resultOrPromise
  }
}

let getInitialChoices = async (props: InvokeChoicesProps) => {
  if (typeof props.choices === "function") {
    return await invokeChoices({ ...props, input: "" })
  } else {
    displayChoices(props)
    return props.choices
  }
}

interface WaitForPromptValueProps extends Omit<DisplayChoicesProps, "input"> {
  validate?: PromptConfig["validate"]
}

let waitForPromptValue = ({
  choices,
  validate,
  className,
  onNoChoices,
  onChoices
}: WaitForPromptValueProps) =>
  new Promise((resolve, reject) => {
    promptId++
    let ct = {
      promptId,
      tabIndex: global.onTabIndex,
    }

    let process$ = new Observable<AppMessage>(observer => {
      let m = (data: AppMessage) => {
        observer.next(data)
      }
      let e = (error: Error) => {
        observer.error(error)
      }
      process.on("message", m)
      process.on("error", e)
      return () => {
        process.off("message", m)
        process.off("error", e)
      }
    }).pipe(share())

    let tab$ = process$.pipe(
      filter(data => data.channel === Channel.TAB_CHANGED),
      tap(data => {
        let tabIndex = global.onTabs.findIndex(
          ({ name }) => {
            return name == data?.tab
          }
        )

        // console.log(`\nUPDATING TAB: ${tabIndex}`)
        global.onTabIndex = tabIndex
        global.currentOnTab = global.onTabs[tabIndex].fn(
          data?.input
        )
      }),
      share()
    )

    let message$ = process$.pipe(takeUntil(tab$))

    let valueSubmitted$ = message$.pipe(
      filter(
        data => data.channel === Channel.VALUE_SUBMITTED
      )
    )

    let value$ = valueSubmitted$.pipe(
      tap(data => {
        if (data.flag) {
          global.flag[data.flag] = true
        }
      }),
      map(data => data.value),
      switchMap(async value => {
        if (validate) {
          let validateMessage = await validate(value)

          if (typeof validateMessage === "string") {
            let convert = new Convert()
            global.setHint(convert.toHtml(validateMessage))
            global.setChoices(global.kitPrevChoices)
          } else {
            return value
          }
        } else {
          return value
        }
      }),
      filter(value => typeof value !== "undefined"),
      take(1)
    )

    let generate$ = message$.pipe(
      filter(
        data => data.channel === Channel.GENERATE_CHOICES
      ),
      takeUntil(value$),
      switchMap(data => of(data.input).pipe(
        switchMap(input => {
          let ct = {
            promptId,
            tabIndex: +Number(global.onTabIndex),
          }

          return invokeChoices({ ct, choices, className, onNoChoices, onChoices, input })
        }),
      )),

    )

    let blur$ = message$.pipe(
      filter(
        data => data.channel === Channel.PROMPT_BLURRED
      ),
      takeUntil(value$)
    )

    blur$.subscribe(() => {
      exit()
    })

    let onChoices$ = message$.pipe(
      filter(data => [Channel.CHOICES, Channel.NO_CHOICES].includes(data.channel)),
      switchMap(x => of(x)),
      takeUntil(value$),
      share()
    )

    onChoices$.subscribe(async data => {
      switch (data.channel) {
        case Channel.CHOICES:
          await onChoices(data.input)
          break
        case Channel.NO_CHOICES:
          await onNoChoices(data.input)
          break
      }
    })

    generate$.subscribe()

    let initialChoices$ = of<InvokeChoicesProps>({
      ct,
      choices,
      className,
      input: "",
      onNoChoices,
      onChoices
    }).pipe(
      // filter(() => ui === UI.arg),
      switchMap(getInitialChoices)
    )

    let choice$ = message$.pipe(
      filter(
        data => data.channel === Channel.CHOICE_FOCUSED
      )
    )

    choice$
      .pipe(
        takeUntil(value$),
        switchMap(data => {
          let choice = (global.kitPrevChoices || []).find(
            (c: Choice) => c.id === data?.id
          )

          if (
            choice &&
            choice?.preview &&
            typeof choice?.preview === "function" &&
            choice?.preview[Symbol.toStringTag] ===
            "AsyncFunction"
          ) {
            ; (choice as any).index = data?.index
              ; (choice as any).input = data?.input

            try {
              return choice?.preview(choice)
            } catch {
              return `Failed to render preview`
            }
          }

          return ``
        }),
        debounceTime(0),
        withLatestFrom(onChoices$),
      )

      .subscribe(async ([preview, onChoiceData]: [string, AppMessage]) => {
        if (onChoiceData.channel === Channel.CHOICES) {
          global.setPreview(preview)
        }
      })

    initialChoices$.pipe(takeUntil(value$)).subscribe()

    merge(value$).subscribe({
      next: value => {
        resolve(value)
      },
      complete: () => {
        // console.log(`Complete: ${promptId}`)
      },
      error: error => {
        reject(error)
      },
    })
  })

let onNoChoicesDefault = async (input: string) => {
  setPreview(`<div/>`)
}

let onChoicesDefault = async (input: string) => { }

global.kitPrompt = async (config: PromptConfig) => {
  await Promise.resolve(true) //need to let tabs finish...
  let {
    ui = UI.arg,
    placeholder = "",
    validate = null,
    strict = Boolean(config?.choices),
    choices = [],
    secret = false,
    hint = "",
    input = "",
    ignoreBlur = false,
    mode = Mode.FILTER,
    className = "",
    flags = undefined,
    selected = "",
    type = "text",
    preview = "",
    onNoChoices = onNoChoicesDefault,
    onChoices = onChoicesDefault,
  } = config
  if (flags) {
    setFlags(flags)
  }

  global.setMode(
    typeof choices === "function" && choices?.length > 0
      ? Mode.GENERATE
      : mode
  )

  let tabs = global.onTabs?.length
    ? global.onTabs.map(({ name }) => name)
    : []

  global.send(Channel.SET_PROMPT_DATA, {
    tabs,
    tabIndex: global.onTabs?.findIndex(
      ({ name }) => global.arg?.tab
    ),
    placeholder: stripAnsi(placeholder),
    kitScript: global.kitScript,
    parentScript: global.env.KIT_PARENT_NAME,
    kitArgs: global.args.join(" "),
    secret,
    ui,
    strict,
    selected,
    type,
    ignoreBlur,
    hasPreview: Boolean(preview),
  })

  global.setHint(hint)
  if (input) global.setInput(input)
  if (ignoreBlur) global.setIgnoreBlur(true)

  if (preview && typeof preview === "function") {
    global.setPreview(await preview())
  }

  return await waitForPromptValue({
    choices,
    validate,
    className,
    onNoChoices,
    onChoices,
  })
}

global.drop = async (
  placeholder = "Waiting for drop..."
) => {
  return await global.kitPrompt({
    ui: UI.drop,
    placeholder,
    ignoreBlur: true,
  })
}

global.form = async (html = "", formData = {}) => {
  send(Channel.SET_FORM_HTML, { html, formData })
  return await global.kitPrompt({
    ui: UI.form,
  })
}

let maybeWrapHtml = (html, containerClasses) => {
  return html?.length === 0
    ? ``
    : `<div class="${containerClasses}">${html}</div>`
}

global.div = async (html = "", containerClasses = "") => {
  return await global.kitPrompt({
    choices: maybeWrapHtml(html, containerClasses),
    ui: UI.div,
  })
}

global.editor = async (
  options: EditorConfig = {
    value: "",
    language: "",
    scrollTo: "top",
  }
) => {
  send(Channel.SET_EDITOR_CONFIG, {
    options:
      typeof options === "string"
        ? { value: options }
        : options,
  })
  return await global.kitPrompt({
    ui: UI.editor,
    ignoreBlur: true,
  })
}

global.hotkey = async (
  placeholder = "Press a key combo:"
) => {
  return await global.kitPrompt({
    ui: UI.hotkey,
    placeholder,
  })
}

global.arg = async (
  placeholderOrConfig = "Type a value:",
  choices
) => {
  let firstArg = global.args.length
    ? global.args.shift()
    : null

  if (firstArg) {
    let validate = (placeholderOrConfig as PromptConfig)
      ?.validate

    if (typeof validate === "function") {
      let valid = await validate(firstArg)

      if (valid === true) return firstArg

      let convert = new Convert()

      let hint =
        valid === false
          ? `${firstArg} is not a valid value`
          : convert.toHtml(valid)
      return global.arg({
        ...(placeholderOrConfig as PromptConfig),
        hint,
      })
    } else {
      return firstArg
    }
  }

  if (typeof placeholderOrConfig === "string") {
    return await global.kitPrompt({
      ui: UI.arg,
      placeholder: placeholderOrConfig,
      choices: choices,
    })
  }

  return await global.kitPrompt({
    choices: choices,
    ...placeholderOrConfig,
  })
}

global.textarea = async (
  options = {
    value: "",
    placeholder: `cmd + s to submit\ncmd + w to close`,
  }
) => {
  send(Channel.SET_TEXTAREA_CONFIG, {
    options:
      typeof options === "string"
        ? { value: options }
        : options,
  })
  return await global.kitPrompt({
    ui: UI.textarea,
    ignoreBlur: true,
  })
}

global.args = []
global.updateArgs = arrayOfArgs => {
  let argv = minimist(arrayOfArgs)
  global.args = [...argv._, ...global.args]
  global.argOpts = Object.entries(argv)
    .filter(([key]) => key != "_")
    .flatMap(([key, value]) => {
      if (typeof value === "boolean") {
        if (value) return [`--${key}`]
        if (!value) return [`--no-${key}`]
      }
      return [`--${key}`, value as string]
    })

  assignPropsTo(argv, global.arg)
  global.flag = { ...argv, ...global.flag }
  delete global.flag._
}

global.updateArgs(process.argv.slice(2))

let appInstall = async packageName => {
  if (!global.arg?.trust) {
    let placeholder = `${packageName} is required for this script`

    let packageLink = `https://npmjs.com/package/${packageName}`

    let hint = `[${packageName}](${packageLink}) has had ${(
      await get<{ downloads: number }>(
        `https://api.npmjs.org/downloads/point/last-week/` +
        packageName
      )
    ).data.downloads
      } downloads from npm in the past week`

    let trust = await global.arg(
      { placeholder, hint: md(hint), ignoreBlur: true },
      [
        {
          name: `Abort`,
          value: "false",
        },
        {
          name: `Install ${packageName}`,
          value: "true",
        },
      ]
    )

    if (trust === "false") {
      echo(`Ok. Exiting...`)
      exit()
    }
  }

  setHint(`Installing ${packageName}...`)
  setIgnoreBlur(true)

  await global.cli("install", packageName)
}

let { createNpm } = await import("../api/npm.js")
global.npm = createNpm(appInstall)

global.setPanel = async (h, containerClasses = "") => {
  let html = maybeWrapHtml(h, containerClasses)
  global.send(Channel.SET_PANEL, {
    html,
  })
}

global.setPreview = async (h, containerClasses = "") => {
  let html = maybeWrapHtml(h, containerClasses)
  global.send(Channel.SET_PREVIEW, {
    html,
  })
}

global.setMode = async mode => {
  global.send(Channel.SET_MODE, {
    mode,
  })
}

global.setHint = async hint => {
  global.send(Channel.SET_HINT, {
    hint,
  })
}

global.setInput = async input => {
  global.send(Channel.SET_INPUT, {
    input,
  })
}

global.setIgnoreBlur = async ignore => {
  global.send(Channel.SET_IGNORE_BLUR, { ignore })
}

global.getDataFromApp = async channel => {
  if (process?.send) {
    return await new Promise((res, rej) => {
      let messageHandler = data => {
        if (data.channel === channel) {
          res(data)
          process.off("message", messageHandler)
        }
      }
      process.on("message", messageHandler)

      send(`GET_${channel}`)
    })
  } else {
    return {}
  }
}

global.getBackgroundTasks = () =>
  global.getDataFromApp("BACKGROUND")

global.getSchedule = () => global.getDataFromApp("SCHEDULE")
global.getBounds = async () => {
  let data = await global.getDataFromApp("BOUNDS")
  return data?.bounds
}

global.getCurrentScreen = async () => {
  let data = await global.getDataFromApp("CURRENT_SCREEN")
  return data?.screen
}

global.getScriptsState = () =>
  global.getDataFromApp("SCRIPTS_STATE")

global.setBounds = (bounds: Partial<Rectangle>) => {
  global.send(Channel.SET_BOUNDS, {
    bounds,
  })
}

global.getClipboardHistory = async () =>
  (await global.getDataFromApp("CLIPBOARD_HISTORY"))
    ?.history

global.removeClipboardItem = (id: string) => {
  global.send(Channel.REMOVE_CLIPBOARD_HISTORY_ITEM, { id })
}

global.submit = (value: any) => {
  global.send(Channel.SET_SUBMIT_VALUE, { value })
}

global.wait = async (time: number) => {
  global.submit(null)

  return new Promise(res => setTimeout(() => {
    res()
  }, time))
}

delete process.env?.["ELECTRON_RUN_AS_NODE"]
delete global?.env?.["ELECTRON_RUN_AS_NODE"]
