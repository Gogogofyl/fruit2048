# -*- coding: utf-8 -*-
"""
生成软著申报配套文档：
1. 申报填写指南（逐字段给出建议值）
2. 非职务开发保证书（打印签字用）
"""

import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = r"D:\fylcode\DigitalHuman\小游戏2048"
OUT_DIR = os.path.join(ROOT, "soft-copyright")
os.makedirs(OUT_DIR, exist_ok=True)

pdfmetrics.registerFont(TTFont("SimSun", r"C:\Windows\Fonts\simsun.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("SimHei", r"C:\Windows\Fonts\simhei.ttf"))

APP_NAME = "珍馐水果合成"
VERSION = "V1.0"
SOURCE_LINES = "1481"

title_style = ParagraphStyle("title", fontName="SimHei", fontSize=18, leading=26, spaceAfter=10, alignment=1)
h1 = ParagraphStyle("h1", fontName="SimHei", fontSize=13, leading=20, spaceBefore=12, spaceAfter=6)
h2 = ParagraphStyle("h2", fontName="SimHei", fontSize=11, leading=17, spaceBefore=8, spaceAfter=4)
body = ParagraphStyle("body", fontName="SimSun", fontSize=10, leading=17, spaceAfter=4)
cell = ParagraphStyle("cell", fontName="SimSun", fontSize=9, leading=14)
cellb = ParagraphStyle("cellb", fontName="SimHei", fontSize=9, leading=14)


def p(text, style=body):
    return Paragraph(text, style)


def build_guide():
    path = os.path.join(OUT_DIR, f"{APP_NAME}_软著申报填写指南.pdf")
    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=18 * mm, bottomMargin=16 * mm,
                            title=f"{APP_NAME} 软著申报填写指南")

    story = []
    story.append(p("计算机软件著作权登记 · 申报填写指南", title_style))
    story.append(p(f"软件名称：{APP_NAME}　版本号：{VERSION}　著作权人：个人", body))
    story.append(Spacer(1, 8))

    story.append(p("一、申报前必须准备好的 3 个文件", h1))
    story.append(p("1. 源程序 PDF：已生成，共 22 页、{0} 行，不足 3000 行故全部提交。页眉为「{1} {2}」。".format(SOURCE_LINES, APP_NAME, VERSION)))
    story.append(p("2. 软件说明书 PDF：已生成，共 11 页，每页不少于 30 行。页眉与源程序完全一致。"))
    story.append(p("3. 身份证正反面扫描件：合并成一个 PDF 更稳妥（手机拍照后可用任何 PDF 工具合并），要求文字清晰、四角完整、无遮挡。"))
    story.append(p("以上三者中的软件名称、版本号必须一字不差。源程序与说明书页眉写的是「{0} {1}」，含字母 V。".format(APP_NAME, VERSION)))

    story.append(p("二、注册账号与实名认证", h1))
    story.append(p("1. 浏览器打开 https://www.ccopyright.com.cn ，用手机号注册。"))
    story.append(p("2. 登录后进入「用户中心 → 账号管理 → 实名认证」。"))
    story.append(p("3. 上传身份证正反面照片，并按提示完成手持身份证拍照。"))
    story.append(p("4. 实名认证为人工审核，通常 1–3 个工作日。这一步没过之前无法提交申请，所以先做。"))

    story.append(p("三、在线填表：逐字段建议值", h1))
    story.append(p("进入「版权登记 → 计算机软件著作权登记申请 → 立即登记」，办理身份选「我是申请人」。下表左列是表单字段，右列是建议填法。"))

    rows = [
        ("软件全称", f"{APP_NAME}", "必须与两个 PDF 页眉一致，不要加书名号、不要加版本号"),
        ("软件简称", "留空", "官方说明：没有简称就不填，不要写「无」，也不要与全称相同"),
        ("版本号", f"{VERSION}", "含字母 V。若这里写成 1.0，PDF 页眉就对不上，会被判材料不一致"),
        ("软件作品说明", "原创", "本软件为独立开发，非修改他人软件"),
        ("开发完成日期", "2026年11月14日", "填软件固定成型的日期，填当天即可"),
        ("发表状态", "未发表", "游戏尚未上线，选未发表；不要选已发表后编造日期"),
        ("开发方式", "单独开发", "个人独立完成，无需合作开发协议"),
        ("著作权人类别", "自然人", ""),
        ("证件类型 / 号码", "居民身份证 / 本人身份证号", "与上传的身份证完全一致"),
        ("国籍 / 省份", "中国 / 江苏省", "按身份证登记地填写"),
        ("权利取得方式", "原始取得", "不要选受让、继承、承受"),
        ("权利范围", "全部权利", ""),
    ]
    data = [[p("字段", cellb), p("填写内容", cellb), p("注意事项", cellb)]]
    for a, b, c in rows:
        data.append([p(a, cell), p(b, cell), p(c, cell)])

    table = Table(data, colWidths=[32 * mm, 52 * mm, 84 * mm])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.92, 0.92, 0.92)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(table)

    story.append(p("四、软件功能与技术特点（整段复制）", h1))
    story.append(p("硬件环境：运行环境为智能手机（Android 7.0 及以上或 iOS 12.0 及以上），建议 2GB 以上运行内存；开发环境为 x86 个人计算机。"))
    story.append(p("软件环境：运行环境为抖音客户端及抖音小游戏基础库 2.0 以上；开发环境为 Windows 操作系统、Node.js 22。"))
    story.append(p("编程语言：JavaScript。"))
    story.append(p(f"源程序量：{SOURCE_LINES} 行。"))
    story.append(p("主要功能和技术特点（约 250 字，可直接粘贴）："))
    story.append(p("「本软件是一款运行于抖音小游戏平台的数字合并类休闲游戏。软件以 4×4 棋盘为核心场景，通过单指滑动使方块整体位移，相同等级方块相遇即合成为更高一级，共设十一级水果，最高等级为 2048。软件具备本地最高分与对局快照存档、死局判定、通关后继续挑战，以及基于平台静默登录的云端成绩上报与全网排行榜功能。技术特点：采用 Canvas 2D 自绘渲染，逐帧动画驱动滑动位移、新块回弹、合并强调与加分飘字；逻辑层与渲染层分离，棋盘状态可序列化持久化；网络层统一封装平台容器调用，用户身份由平台网关注入，客户端不持有身份凭证。」"))

    story.append(p("五、上传鉴别材料", h1))
    story.append(p("1. 程序鉴别材料：上传源程序 PDF（22 页那一份）。"))
    story.append(p("2. 文档鉴别材料：上传软件说明书 PDF（11 页那一份）。"))
    story.append(p("3. 格式必须是 PDF，不接受 Word、压缩包、图片。文件名保持现状即可。"))
    story.append(p("4. 上传后核对系统显示的页数：源程序 22 页、说明书 11 页，与文件一致再提交。"))

    story.append(p("六、提交与跟踪", h1))
    story.append(p("1. 核对全部信息后确认提交，按提示完成签章页签署（自然人本人签名）。"))
    story.append(p("2. 提交后在「我的登记」中查看状态：待受理 → 受理中 → 待发放。"))
    story.append(p("3. 受理后 30 个工作日办结，法规规定的上限是 60 日内审查完成。"))
    story.append(p("4. 证书为电子版 PDF，可在用户中心下载。"))

    story.append(p("七、常见驳回原因与规避", h1))
    story.append(p("1. 版本号不一致：申请表填 V1.0，材料页眉写 1.0 —— 直接作废重做。本套材料已按 V1.0 统一。"))
    story.append(p("2. 软件名称不一致：申请表与页眉、与游戏名三处不同 —— 会造成备案与广告投放受阻。三处统一为「{0}」。".format(APP_NAME)))
    story.append(p("3. 页数或行数不足：程序每页不少于 50 行、文档每页不少于 30 行。本套材料为 70 行/页与 33 行/页，已满足。"))
    story.append(p("4. 身份证明不清：身份证照片模糊、反光、缺角。用扫描或平整桌面拍照。"))
    story.append(p("5. 提交非 PDF 格式或材料打包成压缩包。"))
    story.append(p("6. 开发完成日期晚于提交日期：填当天或之前均可，不要填未来日期。"))

    story.append(p("八、时间与费用", h1))
    story.append(p("官方自行办理：登记免费，受理后 30 个工作日左右出证，实际常见 1–2 个月。"))
    story.append(p("加急代办：付费，5–15 个工作日。若游戏急着上线可考虑，否则不建议多花这笔钱。"))
    story.append(p("重要提醒：本套材料对应的是当前 V1.0 代码。后续继续开发新功能（复活、榜单界面等）不需要重新登记，软著保护的是已登记的这一版代码表达。若功能发生重大变化，可选择按新版本另行登记。"))

    doc.build(story)
    return path


def build_guarantee():
    path = os.path.join(OUT_DIR, "非职务开发保证书_模板.pdf")
    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=25 * mm, rightMargin=25 * mm,
                            topMargin=25 * mm, bottomMargin=20 * mm,
                            title="非职务开发保证书")

    story = []
    story.append(p("非职务开发保证书", ParagraphStyle("t", fontName="SimHei", fontSize=20, leading=30, alignment=1, spaceAfter=18)))

    story.append(p("中国版权保护中心：", body))
    story.append(Spacer(1, 6))
    story.append(p("本人　　　　　　　　，身份证号码　　　　　　　　　　　　　　　　　　，现就本人申请登记的软件《{0}》（版本号 {1}）作出如下保证：".format(APP_NAME, VERSION), body))
    story.append(Spacer(1, 4))
    story.append(p("一、该软件由本人独立开发完成，开发过程中未使用本人任职单位的物质技术条件，未利用单位的资金、设备、场地、资料，亦未承担单位交付的开发任务。", body))
    story.append(p("二、该软件不属于《计算机软件保护条例》所规定的职务软件，其著作权归本人单独享有，与本人任职单位无关。", body))
    story.append(p("三、本人保证上述内容真实。如因本保证内容不实引起权属争议或其他法律责任，由本人承担全部责任。", body))
    story.append(Spacer(1, 10))
    story.append(p("保证人（签字）：　　　　　　　　　　　　", body))
    story.append(Spacer(1, 6))
    story.append(p("日　　期：　　　　年　　　月　　　日", body))
    story.append(Spacer(1, 16))
    story.append(p("使用说明：本页打印后由本人手写签名并填写日期即可。当前线上申请流程中，个人独立开发通常只需提交身份证；若审查人员要求补充非职务开发证明，提交本页扫描件。请勿预先填写未确认的信息。", ParagraphStyle("n", fontName="SimSun", fontSize=9, leading=15, textColor=colors.Color(0.4, 0.4, 0.4))))

    doc.build(story)
    return path


if __name__ == "__main__":
    g = build_guide()
    b = build_guarantee()
    for f in (g, b):
        print("生成:", f, os.path.getsize(f), "字节")
