import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StarRatingStaticProps {
  rating: number
  maxRating?: number
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

export function StarRatingStatic({
  rating,
  maxRating = 5,
  size = 'md',
}: StarRatingStaticProps) {
  const sizeClasses = {
    xs: 'w-3 h-3',
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  }

  // 静态评分此前是一排纯装饰 SVG，读屏完全读不到分数。
  // 这里给整组一个 role="img" + 「分数/满分」的标签，并让星形本身对读屏隐藏，
  // 避免出现「5 个没有名字的图形」这种噪音。
  return (
    <div
      className="flex items-center gap-0.5"
      role="img"
      aria-label={`${Math.max(0, Math.min(rating, maxRating))}/${maxRating}`}
    >
      {Array.from({ length: maxRating }, (_, i) => (
        <Star
          key={i}
          aria-hidden="true"
          className={cn(
            sizeClasses[size],
            i < rating
              ? 'fill-yellow-400 text-yellow-400'
              : 'fill-muted text-muted-foreground/30'
          )}
        />
      ))}
    </div>
  )
}
