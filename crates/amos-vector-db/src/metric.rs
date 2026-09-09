//! Similarity metrics used to rank stored vectors against a query.
//!
//! Both treat the inputs as **untrusted caller data** and return an error on a
//! length mismatch rather than silently reading out of bounds. A zero vector is
//! guarded (cosine of a zero vector is undefined → we return `0.0`, never
//! `NaN`), so a degenerate row can never corrupt the ordering.

use crate::error::{Result, VectorDbError};

/// Which similarity to rank with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    /// Cosine similarity in `[-1, 1]`; robust to vector scale (this is what a
    /// consumer usually wants for text embeddings).
    Cosine,
    /// Plain dot product (unnormalised). Favours larger-magnitude vectors.
    Dot,
}

/// Unit (L2) norm of a slice. Returns an error when lengths are zero (guarded
/// upstream, but kept total/panic-free regardless).
fn norm(a: &[f32]) -> f32 {
    a.iter().fold(0.0_f32, |acc, v| acc + v * v).sqrt()
}

/// Dimension-checked dot product. Returns [`VectorDbError::DimMismatch`] when
/// the two slices differ in length.
pub fn dot(a: &[f32], b: &[f32]) -> Result<f32> {
    if a.len() != b.len() {
        return Err(VectorDbError::DimMismatch {
            expected: a.len(),
            got: b.len(),
        });
    }
    Ok(a.iter().zip(b).fold(0.0_f32, |acc, (x, y)| acc + x * y))
}

/// Dimension-checked cosine similarity in `[-1, 1]`. Either input being the
/// zero vector yields `0.0` (never `NaN`).
pub fn cosine(a: &[f32], b: &[f32]) -> Result<f32> {
    if a.len() != b.len() {
        return Err(VectorDbError::DimMismatch {
            expected: a.len(),
            got: b.len(),
        });
    }
    let (na, nb) = (norm(a), norm(b));
    if na == 0.0 || nb == 0.0 {
        return Ok(0.0);
    }
    Ok(a.iter().zip(b).fold(0.0_f32, |acc, (x, y)| acc + x * y) / (na * nb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_mismatch_is_error() {
        assert!(dot(&[1.0], &[1.0, 2.0]).is_err());
        assert!(cosine(&[1.0], &[1.0, 2.0]).is_err());
    }

    #[test]
    fn dot_is_sum_of_products() {
        assert_eq!(dot(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]).expect("ok"), 32.0);
    }

    #[test]
    fn cosine_identical_unit_is_one() {
        let v = [1.0_f32, 0.0];
        assert!((cosine(&v, &v).expect("ok") - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_unit_is_minus_one() {
        let a = [1.0_f32, 0.0];
        let b = [-1.0_f32, 0.0];
        assert!((cosine(&a, &b).expect("ok") + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        let a = [1.0_f32, 0.0];
        let b = [0.0_f32, 1.0];
        assert!((cosine(&a, &b).expect("ok")).abs() < 1e-6);
    }

    #[test]
    fn cosine_zero_vector_never_nan() {
        let zero = [0.0_f32, 0.0];
        let v = [1.0_f32, 2.0];
        assert_eq!(cosine(&zero, &v).expect("ok"), 0.0);
        assert_eq!(cosine(&v, &zero).expect("ok"), 0.0);
        assert_eq!(cosine(&zero, &zero).expect("ok"), 0.0);
        assert!(cosine(&zero, &v).expect("ok").is_finite());
    }

    #[test]
    fn cosine_scale_invariant() {
        let a = [1.0_f32, 2.0];
        let b = [10.0_f32, 20.0]; // same direction as a
        assert!((cosine(&a, &b).expect("ok") - 1.0).abs() < 1e-6);
    }
}
