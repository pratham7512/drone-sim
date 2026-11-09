import AVFoundation
import AppKit

let input = "/Users/curious/Desktop/drone/drone-sim.mp4"
let output = "/private/var/folders/8f/sthz3w_56w5czfjrq5475vgr0000gn/T/opencode/drone-video-frames-av/contact-sheet.png"
let asset = AVURLAsset(url: URL(fileURLWithPath: input))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)
generator.maximumSize = CGSize(width: 640, height: 360)

let cols = 5
let rows = 4
let cell = CGSize(width: 320, height: 180)
let sheet = NSImage(size: CGSize(width: cell.width * CGFloat(cols), height: cell.height * CGFloat(rows)))
sheet.lockFocus()
NSColor.black.setFill()
NSRect(origin: .zero, size: sheet.size).fill()

for index in 0..<(cols * rows) {
    let time = 1.0 + Double(index) * 2.6
    guard time < asset.duration.seconds else { break }
    do {
        let cg = try generator.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 600), actualTime: nil)
        let image = NSImage(cgImage: cg, size: cell)
        let col = index % cols
        let row = index / cols
        let rect = NSRect(
            x: CGFloat(col) * cell.width,
            y: sheet.size.height - CGFloat(row + 1) * cell.height,
            width: cell.width,
            height: cell.height
        )
        image.draw(in: rect)
        let label = String(format: "%.1fs", time)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 16, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        label.draw(at: NSPoint(x: rect.minX + 8, y: rect.maxY - 24), withAttributes: attrs)
    } catch {
        print("failed", time)
    }
}
sheet.unlockFocus()

let rep = NSBitmapImageRep(data: sheet.tiffRepresentation!)!
let data = rep.representation(using: .png, properties: [:])!
try data.write(to: URL(fileURLWithPath: output))
print(output)
