; ============================================================================
;  SLCL 启动器 - 安装 / 卸载程序自定义脚本
;
;  electron-builder 通过 `nsis.include` 引入本文件，内容会被拼接到主脚本最前面，
;  因此这里定义的 !macro 会先于模板里的 !ifmacrodef 判定，Var 也处于全局作用域。
;
;  三个实测得到的关键约束：
;   1. electron-builder 以 -WX 调用 makensis，任何 warning 都算错误；覆盖内置
;      LangString 必然触发 warning 6030，故全局关闭该告警。
;   2. 内置文案由 `!insertmacro addLangs` 展开（位置在模板里），本文件被前置，
;      所以 LangString 必须写进 customHeader（插入点恰在 addLangs 之后），否则
;      会被官方文案覆盖回去（NSIS 同名 LangString 以最后一次定义为准）。
;   3. NSIS 自带的目录页遇到盘根目录（D:\）只会静默禁用「安装」按钮，不告诉
;      用户原因，所以这里用自绘目录页替换它：选到盘根目录时自动补成 D:\SLCL
;      并回显，用户能直接看到实际安装位置。（electron-builder 的
;      allowToChangeInstallationDirectory 已在 electron-builder.yml 中关闭。）
; ============================================================================

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; 覆盖内置 LangString 必然重复定义，全局关闭 6030。
!pragma warning disable 6030

; ---------------------------------------------------------------------------
; 侧边栏插图：electron-builder 默认用 NSIS 自带的 metro 图，这里换成 SLCL 品牌图。
; 该 define 由命令行 -D 传入，必须先 !undef 才能重新定义。
; ---------------------------------------------------------------------------
!ifdef MUI_WELCOMEFINISHPAGE_BITMAP
  !undef MUI_WELCOMEFINISHPAGE_BITMAP
!endif
!define MUI_WELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"

!ifdef MUI_UNWELCOMEFINISHPAGE_BITMAP
  !undef MUI_UNWELCOMEFINISHPAGE_BITMAP
!endif
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"

; ---------------------------------------------------------------------------
; 变量
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
  Var SlclDirEdit
  Var SlclDirBrowse
!endif

; 卸载页的勾选框状态（只在卸载程序里用；装在安装程序里会触发「未使用变量」告警）
!ifdef BUILD_UNINSTALLER
  Var SlclCacheCheckbox
  Var SlclDeleteCache
!endif

; ---------------------------------------------------------------------------
; 盘根目录检测
;
;   输入 $0（路径），输出 $1 = "1" 表示是盘根目录，否则 "0"。
;   末尾的反斜杠先剥掉，因此 "D:"、"D:\" 都会被识别。
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
  Function slclIsDriveRoot
    StrCpy $1 "0"
    StrCpy $2 $0

    ; 去掉末尾所有反斜杠
    ${Do}
      StrCpy $3 $2 1 -1
      ${If} $3 != "\"
        ${ExitDo}
      ${EndIf}
      StrCpy $2 $2 -1
    ${Loop}

    ; 只剩 "D:" 这种两字符形式即为盘根目录
    StrLen $3 $2
    ${If} $3 == 2
      StrCpy $4 $2 1 1
      ${If} $4 == ":"
        StrCpy $1 "1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  ; -------------------------------------------------------------------------
  ; 安装目录归一化
  ;
  ;   只在「选到盘根目录」时介入：D:\ 自动变成 D:\SLCL，避免几百 MB 文件散落
  ;   到磁盘根目录。其它路径完全尊重用户输入，不做任何改写。
  ;   函数是幂等的：对 D:\SLCL 再执行一次不会有任何变化。
  ; -------------------------------------------------------------------------
  Function slclNormalizeInstallDir
    ; 先去掉末尾反斜杠："D:\" 变成 "D:"
    ${Do}
      StrCpy $R1 $INSTDIR 1 -1
      ${If} $R1 != "\"
        ${ExitDo}
      ${EndIf}
      StrCpy $INSTDIR $INSTDIR -1
    ${Loop}

    ; 盘根目录：补上 SLCL 子文件夹
    StrCpy $0 $INSTDIR
    Call slclIsDriveRoot
    ${If} $1 == "1"
      StrCpy $INSTDIR "$INSTDIR\SLCL"
    ${EndIf}
  FunctionEnd
!endif

; ---------------------------------------------------------------------------
; 1. 内置文案改写：少用「该应用 / 该软件」，统一说「SLCL 启动器」
;    插入点位于 addLangs 之后，因此这里的定义会覆盖内置文案。
; ---------------------------------------------------------------------------
!macro customHeader
  LangString whoShouldThisApplicationBeInstalledFor 2052 "为哪位用户安装 SLCL 启动器？"
  LangString whoShouldThisApplicationBeInstalledFor 1033 "Who should SLCL Launcher be installed for?"

  LangString selectUserMode 2052 "请选择将 SLCL 启动器安装给本机所有用户，还是仅安装给您自己。"
  LangString selectUserMode 1033 "Please choose whether SLCL Launcher is available to everyone on this computer, or only to you."

  LangString forAll 2052 "为使用这台电脑的所有用户安装"
  LangString forAll 1033 "Anyone who uses this computer (all users)"

  LangString onlyForMe 2052 "仅为我安装"
  LangString onlyForMe 1033 "Only for me"

  LangString freshInstallForAll 2052 "为所有用户全新安装 SLCL 启动器（需要管理员权限）"
  LangString freshInstallForAll 1033 "Fresh install of SLCL Launcher for all users. (will prompt for admin credentials)"

  LangString freshInstallForCurrent 2052 "仅为当前用户全新安装 SLCL 启动器。"
  LangString freshInstallForCurrent 1033 "Fresh install of SLCL Launcher for the current user only."

  LangString chooseInstallationOptions 2052 "安装选项"
  LangString chooseInstallationOptions 1033 "SLCL Launcher - Installation Options"

  LangString chooseUninstallationOptions 2052 "卸载选项"
  LangString chooseUninstallationOptions 1033 "SLCL Launcher - Uninstallation Options"

  LangString whichInstallationShouldBeRemoved 2052 "需要移除哪个 SLCL 启动器安装？"
  LangString whichInstallationShouldBeRemoved 1033 "Which SLCL Launcher installation should be removed?"

  LangString whichInstallationRemove 2052 "SLCL 启动器同时为所有用户和当前用户安装过。$\r$\n您希望移除哪一个？"
  LangString whichInstallationRemove 1033 "SLCL Launcher is installed both per-machine (all users) and per-user.$\r$\nWhich installation would you like to remove?"

  LangString perUserInstall 2052 "已存在一个安装给当前用户的 SLCL 启动器。"
  LangString perUserInstall 1033 "There is a per-user installation of SLCL Launcher."

  LangString perMachineInstall 2052 "已存在一个安装给所有用户的 SLCL 启动器。"
  LangString perMachineInstall 1033 "There is a per-machine installation of SLCL Launcher."

  ; 「已存在安装」提示
  LangString perUserInstallExists 2052 "检测到已安装的 SLCL 启动器。"
  LangString perUserInstallExists 1033 "An existing SLCL Launcher installation was found."

  LangString perMachineInstallExists 2052 "检测到已为所有用户安装的 SLCL 启动器。"
  LangString perMachineInstallExists 1033 "An existing all-users SLCL Launcher installation was found."

  LangString reinstallUpgrade 2052 "继续将覆盖安装或升级。"
  LangString reinstallUpgrade 1033 "Continuing will reinstall or upgrade it."

  LangString uninstall 2052 "继续将卸载。"
  LangString uninstall 1033 "Continuing will uninstall it."

  ; 卸载完成页
  LangString MUI_UNTEXT_FINISH_INFO_TITLE 2052 "SLCL 启动器卸载完成"
  LangString MUI_UNTEXT_FINISH_INFO_TITLE 1033 "SLCL Launcher has been uninstalled"

  LangString MUI_UNTEXT_FINISH_INFO_TEXT 2052 "SLCL 启动器已从您的电脑中移除。$\r$\n$\r$\n感谢您的使用，欢迎随时回来。"
  LangString MUI_UNTEXT_FINISH_INFO_TEXT 1033 "SLCL Launcher has been removed from your computer.$\r$\n$\r$\nThanks for using it."
!macroend

; ---------------------------------------------------------------------------
; 2. 静默安装（/S /D=…）不经过任何页面，在这里也做一次盘根目录归一化
; ---------------------------------------------------------------------------
!macro customInit
  Call slclNormalizeInstallDir
!macroend

; ---------------------------------------------------------------------------
; 3. 安装向导：欢迎页 + 自绘安装位置页
; ---------------------------------------------------------------------------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 SLCL 启动器安装程序"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "此向导将引导您完成 SLCL 启动器的安装。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; 自绘安装位置页：替代 MUI 自带的目录页（后者会拒绝盘根目录）
!macro customPageAfterChangeDir
  Page custom slclDirPageCreate slclDirPageLeave

  Function slclDirPageCreate
    ; 升级安装时沿用原位置，不打扰用户
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "选择安装位置" "选择 SLCL 启动器的安装文件夹"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0u 0u 100% 26u "SLCL 启动器将安装到下面的文件夹，也可以直接修改路径。"
    Pop $0

    ; 路径框与「浏览...」共用宽度：按钮需容纳两个全角字加省略号，
    ; 22u 会裁掉文字，这里固定 34u。
    ${NSD_CreateText} 0u 34u -36u 13u "$INSTDIR"
    Pop $SlclDirEdit

    ${NSD_CreateBrowseButton} -34u 34u 34u 13u "浏览..."
    Pop $SlclDirBrowse
    ${NSD_OnClick} $SlclDirBrowse slclDirBrowseClicked

    ${NSD_CreateLabel} 0u 54u 100% 26u "若选择盘符根目录（如 D:\），将自动安装到 D:\SLCL。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function slclDirBrowseClicked
    ${NSD_GetText} $SlclDirEdit $0
    nsDialogs::SelectFolderDialog "选择 SLCL 启动器的安装位置" "$0"
    Pop $0
    ${If} $0 != error
      ; 选到盘根目录时立刻把补全后的路径显示出来，用户能预知实际安装位置
      StrCpy $INSTDIR $0
      Call slclNormalizeInstallDir
      ${NSD_SetText} $SlclDirEdit "$INSTDIR"
    ${EndIf}
  FunctionEnd

  Function slclDirPageLeave
    ${NSD_GetText} $SlclDirEdit $INSTDIR

    ; 空路径
    ${If} $INSTDIR == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "请先选择一个安装位置。"
      Abort
    ${EndIf}

    ; 盘根目录自动补 SLCL。写入后再回显一次，让下一步看到的就是真实安装路径。
    Call slclNormalizeInstallDir
    ${NSD_SetText} $SlclDirEdit "$INSTDIR"
  FunctionEnd
!macroend

; ---------------------------------------------------------------------------
; 4. 安装完成页
; ---------------------------------------------------------------------------
!macro customFinishPage
  Function slclStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "SLCL 启动器安装完成"
  !define MUI_FINISHPAGE_TEXT "SLCL 启动器已安装完成。$\r$\n$\r$\n可从桌面快捷方式或开始菜单启动。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "立即运行 SLCL 启动器"
  !define MUI_FINISHPAGE_RUN_FUNCTION "slclStartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ---------------------------------------------------------------------------
; 5. 卸载：品牌欢迎页 + 缓存勾选页 + 最终确认
; ---------------------------------------------------------------------------
!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "卸载 SLCL 启动器"
  !define MUI_UNWELCOMEPAGE_TITLE_3LINES
  !define MUI_UNWELCOMEPAGE_TEXT "此向导将从您的电脑中移除 SLCL 启动器。$\r$\n$\r$\n游戏存档、模组与已安装的游戏版本不会被删除。"
  !insertmacro MUI_UNPAGE_WELCOME

  UninstPage custom un.slclCachePageCreate un.slclCachePageLeave

  Function un.slclCachePageCreate
    !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否同时删除 SLCL 启动器的缓存数据"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0u 0u 300u 26u "账户登录状态、主题设置与皮肤缓存默认保留，重新安装后可继续使用。"
    Pop $0

    ${NSD_CreateCheckbox} 0u 30u 300u 14u "同时删除 SLCL 启动器缓存数据"
    Pop $SlclCacheCheckbox
    ${If} $SlclDeleteCache == 1
      ${NSD_Check} $SlclCacheCheckbox
    ${EndIf}

    ${NSD_CreateLabel} 12u 54u 288u 30u "位置：%APPDATA%\slcl$\r$\n含登录信息、主题与背景设置、皮肤缓存。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function un.slclCachePageLeave
    ${NSD_GetState} $SlclCacheCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $SlclDeleteCache 1
    ${Else}
      StrCpy $SlclDeleteCache 0
    ${EndIf}

    ; 真正开始卸载前的最终确认（默认焦点在「否」，避免误触）
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "确定要卸载 SLCL 启动器吗？$\r$\n$\r$\n卸载完成后，需要重新运行安装程序才能再次使用。" IDYES +2
    Abort
  FunctionEnd
!macroend

; ---------------------------------------------------------------------------
; 6. 按勾选结果删除缓存目录
;    electron 始终把用户数据放在当前用户的 Roaming 下；以「所有用户」方式安装时
;    卸载程序是提权的，$APPDATA 会指向管理员账户，所以需要临时切回当前用户上下文。
; ---------------------------------------------------------------------------
!macro customUnInstall
  ${If} $SlclDeleteCache == 1
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    RMDir /r "$APPDATA\slcl"
    RMDir /r "$APPDATA\SLCL"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
